# Plan — desktop membership gate + cloud-projected roster (ADR 0015)

**Date:** 2026-07-18 · **Status:** Implemented (G1–G4, audited 2026-10-04) · **Scope:** `apps/cloud`, `apps/engine`, `apps/desktop`
**Implements:** [`docs/decisions/0015-desktop-requires-workspace-membership.md`](../decisions/0015-desktop-requires-workspace-membership.md)
**Extends:** ADR 0010 (sync model), ADR 0014 (browser auth), plan `0004-desktop-cloud-sync-client.md` (D1–D4 cloud client)
**Depth:** implementation-ready · **Sequencing:** Milestones **G1–G4**, see §Sequencing summary.

## Why this is the next milestone

The desktop app is local-first with cloud strictly opt-in: `App.tsx` gates only on
engine health → *model* onboarding, with no auth or membership gate, and
`CloudConnect.tsx` still notes "most desktop users today are single-player." ADR 0015
inverts that posture: a signed-in cloud identity with membership in ≥1 workspace becomes
the precondition for using the desktop, and the cloud becomes the authority for **which**
workspaces and projects a user has. This plan wires that in without breaking the
offline-first guarantee for an established session.

```
G1 personal-workspace auto-provision ──> G3 desktop gates + roster nav
G2 engine roster cache + graph hydrate ─┘         └──> G4 local-project import
```

## Current baseline (verified against the code on 2026-07-18)

- **Gate order** (`apps/desktop/src/App.tsx`): engine health → `onboarding === "satisfied"` →
  `Workspace`. No auth/membership gate exists.
- **Projects are local-authoritative** (`apps/engine` `/engine/projects`, surfaced by
  `api.ts::listProjects`); each `Project` carries `cloud_workspace_id: string | null`.
- **Sign-in is optional**, lives in `TopBar.tsx`. `resolveWorkspace()` already lists
  memberships (`listCloudWorkspaces`), remembers the last active workspace, auto-enters a
  single membership, and — importantly — already distinguishes "cloud unreachable" from
  "no workspaces." Signed-out shows "Local workspace" + a flat project list.
- **Auth** is the ADR 0014 browser handoff (`startBrowserLogin`/`redeemBrowserLogin`), tokens
  in the keychain, 401-triggered refresh wired 2026-07-18.
- **Sync is push-only** except discussions (M12 gave `apps/engine` its first pull-from-cloud,
  scoped to discussions only). Cloud already serves `GET /workspaces`, `GET /projects`, and
  `GET /sync/projects/{id}/graph` (bootstrap when no `since`), all RLS/membership-scoped.

## G1 — Cloud: personal workspace auto-provisioned on first sign-in

### Decision
On a user's first authenticated request with **zero** workspace memberships, mint a default
workspace **"{user}'s workspace"** with that user as admin. Idempotent (keyed on user id, a
no-op if any membership already exists). This removes the zero-workspace dead-end the new gate
would otherwise create on every fresh account — the single biggest friction ADR 0015 adds.

### Changes
- `apps/cloud`: a create-on-first-login hook (in the auth dependency or the `GET /workspaces`
  handler) that, when a user resolves to 0 memberships, creates the workspace + admin
  membership in one transaction. Must work in **both** data backends (`memory`, `supabase`)
  and satisfy the M2 membership-bootstrap RLS path (migrations 0006–0008).
- No new endpoint — this rides existing workspace creation.

### Tests
- first `GET /workspaces` for a brand-new user returns exactly one workspace (theirs, admin);
- second call is a no-op (still one, not two — idempotent);
- a user who already accepted an invite gets **no** auto-personal-workspace;
- RLS: the new admin membership row satisfies `pz_is_admin` (no bootstrap deadlock).

## G2 — Engine: roster cache + full-graph bootstrap-pull + clear-on-logout

### Decision
The engine keeps a **local mirror of the roster** (workspaces + project metadata) so the
desktop renders offline, and gains a **full-graph bootstrap-pull** so a cloud project not
present locally can be opened. This extends the M12 discussions-only pull to a full hydrate.
The roster is **cloud-authoritative**; the task graph stays **local-authoritative** (ADR 0010
per-field ownership unchanged).

### Changes
- **Roster cache** (new): persist the last-known `GET /workspaces` + `GET /projects` result
  locally (a table or JSON in the engine's SQLite). Refreshed on sign-in, on app focus, and on
  explicit refresh; read offline when the network is down. This is metadata only — never model
  keys, never code (ADR 0010 §5).
- **Full-graph bootstrap-pull** (new): when a roster project has no local graph, hydrate it via
  `GET /sync/projects/{id}/graph` (no `since` = bootstrap, tombstones hidden), draining keyset
  pages (`limit`, `after_ts`, `after_id`) as plan 0004 D2 already does for the incremental path.
  Apply into the local tables as a dumb replica of cloud's merged state (client doesn't re-merge).
- **Clear on logout**: `cloudLogout` wipes the roster cache (workspace/project **names must not
  leak** to the next user of the machine). Local project *graphs* on disk are retained but
  unreachable until re-auth.
- **Project creation becomes workspace-scoped**: a new project requires an active `workspace_id`
  rather than the current "unassigned, optionally link later" path.

### Tests
- roster cache renders the last-known workspaces/projects with the network forced offline;
- opening a cloud project absent locally hydrates its full graph, draining >1 page;
- logout clears the roster cache (no workspace/project names readable afterward);
- creating a project without an active workspace is rejected with a clear error;
- offline-created project is pending-sync and flushes on reconnect (no data loss — reuses D2).

## G3 — Desktop: identity + membership gates, no-workspace state, roster-driven nav

### Decision
Add the two gates ahead of the existing model-onboarding branch (order: **identity →
membership → onboarding**). A **cached, refresh-extended session counts as signed in**, so an
established user works offline; only a cold machine / signed-out / hard-expired session hits the
auth gate. Drop the signed-out "Local workspace" flat view.

### Changes
- **`App.tsx`**: insert `auth?` and `membership?` gate checks before `onboarding !== "satisfied"`.
  Render the ADR 0014 sign-in handoff for the auth gate and the **no-workspace state** for the
  membership gate.
- **No-workspace state** (new screen): *"You're not in a workspace yet"* → create a workspace
  and/or accept an invite (invite acceptance stays in `apps/web` for v1). With G1 shipped, this
  is a rare fallback (e.g. removed from every workspace), not the first-run default.
- **`TopBar.tsx`**: `resolveWorkspace()`'s outcome now **drives a gate**, not just a label.
  Keep the "cloud unreachable ≠ no workspaces" distinction — it becomes the offline state.
  Remove the signed-out flat/"Local workspace" path.
- **`Workspace.tsx`**: project list is roster-driven; new-project creation requires the active
  workspace (pairs with G2's engine change).
- **Feature flag**: the whole desktop gate sits behind a flag for staged rollout; stub/dev auth
  (`AUTH_MODE=stub`, `X-User-Id`) relaxes the gate exactly as auth is relaxed today.

### Tests
- signed-out launch → auth gate; nothing else reachable;
- signed in + 0 workspaces → no-workspace state (blocked from 3S);
- signed in + ≥1 workspace + offline → opens on cached roster, local work continues;
- session hard-expired offline → drops to auth gate;
- membership revoked → next roster pull removes those projects; 0 left → no-workspace state;
- stub mode → gate relaxed, local backend testing still works.

## G4 — Migration: existing local-only projects

### Decision
On first gated launch, existing local-only projects (`cloud_workspace_id = null`) are **surfaced
as an "import to a workspace" prompt**, not silently migrated — the user chooses the target
workspace. This avoids quietly pushing a user's private local project to a shared workspace.

### Changes
- A one-time "N local projects aren't in a workspace — import them?" affordance that links each
  chosen project to a workspace (reusing today's `linkProjectToCloud` + sync).

### Tests
- a pre-existing `cloud_workspace_id = null` project is offered for import, not auto-linked;
- declining leaves it local and unreachable under the gate until imported (documented behavior).

### Implemented (2026-07-19)
- New `apps/desktop/src/components/ImportLocalProjects.tsx`: on the workspace screen (behind
  `VITE_MEMBERSHIP_GATE`, only when signed in with ≥1 workspace), a one-time panel lists every
  local-only project (`cloud_workspace_id === null`) and imports each into a user-picked workspace
  via `linkProjectToCloud` + `triggerCloudSync`. Nothing is auto-linked. "Not now" persists a
  dismissal in `localStorage` (one-time, no per-launch nag) but leaves a compact re-entry link so
  the user can still import later — declined projects stay local and, being absent from the roster,
  unreachable under the gate until imported.
- Resolved G3's name-based roster dedupe gap: the engine's `GET /engine/projects` now also surfaces
  `cloud_project_id` (already recorded per-project by `writeCloudLink` in the `integrations` cloud
  link config — no schema change). `Workspace.tsx` matches a local project to its roster tab by that
  cloud id, falling back to name **only** for a project never linked, so a duplicate name can no
  longer hide a distinct pending project behind the wrong tab.
- Verification: desktop has no test runner (per G3), so the automated gate is `tsc --noEmit` +
  `vite build` (both pass). Behavioral cases (offered-not-auto-linked; decline-leaves-unreachable)
  are covered by manual steps in the milestone report.

## Decisions log

Pinned from ADR 0015 §5 and its action items — do not re-open without new information:

| Decision | Resolution | Where |
|---|---|---|
| Gate frequency | Cold-start only; cached refresh-extended session = signed in | G3 |
| Zero-workspace dead-end | Auto-provision a personal workspace on first sign-in | G1 |
| Refresh-token hard-expiry offline | Drop to the auth gate (can't verify identity) | G3 |
| Existing local-only projects | Import prompt, not silent migration | G4 |
| New cloud endpoints | None in v1 — reuse `GET /workspaces` + `GET /projects` | G2 |

## Sequencing summary
1. **G1** — cloud auto-provision; unblocks a friction-free first run before the gate lands.
2. **G2** — engine roster cache + graph hydrate; the data plane the gate reads from.
3. **G3** — desktop gates + no-workspace state; the visible behavior change (feature-flagged).
4. **G4** — local-project import; cleanup for existing installs, do last.

G1 and G2 are independent and can run in parallel; G3 depends on both; G4 depends on G3.

---

## Implementation prompts (for driving Sonnet, one milestone per session)

Give each session the **kickoff preamble + one milestone prompt**. One milestone = one branch/PR.
Review the work plan Sonnet proposes before letting it implement — that checkpoint catches scope
drift cheaply.

### Kickoff preamble (prepend to every session)

```
You are implementing part of PromptConnext. Before writing any code, read these in order:

1. docs/decisions/0015-desktop-requires-workspace-membership.md — the decision and its boundaries
2. docs/plans/0006-desktop-membership-gate.md — the milestone plan; you implement exactly ONE
   milestone (named below)
3. The ADRs 0015 amends: 0003, 0010, 0011, 0014 — do not contradict them
4. The current code for your milestone's app (apps/cloud | apps/engine | apps/desktop) — match
   its conventions

Hard rules:
- Scope: only the milestone named below. If you find prerequisite gaps, list them and stop —
  don't silently expand scope.
- Do NOT break ADR 0010: the task graph stays local-authoritative; only the roster is
  cloud-authoritative. No new cloud endpoints — reuse GET /workspaces and GET /projects.
- Gate at cold-start only: a cached, refresh-extended session counts as signed in. Do NOT add a
  live network check on launch — that would break offline-first.
- Preserve the stub/dev auth path (AUTH_MODE=stub, X-User-Id) so local testing works.
- apps/cloud features must work in BOTH data backends (memory + supabase); memory first, tests
  pass with no network. New tables get RLS + a non-member-cannot-access test.
- The milestone's "Tests" section in plan 0006 is your definition of done; demonstrate each,
  ideally as an automated test. Run the app's test + lint before declaring done.
- Update any docs you invalidate (README, architecture §2.1/§3.4) in the same PR.

Work plan first: produce a short file-by-file plan (and migration DDL if any), wait for my
approval, then implement.
```

### G1 — Cloud auto-provision

```
Milestone: G1 (plan 0006) — apps/cloud: auto-provision a personal workspace on first sign-in.

When an authenticated user resolves to ZERO workspace memberships, create "{user}'s workspace"
with that user as admin, idempotently (no-op if any membership already exists). Both data
backends. Must satisfy the M2 membership-bootstrap RLS (migrations 0006–0008) — the new admin
row must satisfy pz_is_admin without a bootstrap deadlock.

Exit criteria: plan 0006 §G1 Tests — including idempotency and the "invited user gets no
personal workspace" case.
```

### G2 — Engine roster cache + graph hydrate

```
Milestone: G2 (plan 0006) — apps/engine: local roster cache + full-graph bootstrap-pull +
clear-on-logout.

1. Persist the last GET /workspaces + GET /projects locally so the desktop renders offline;
   refresh on sign-in / focus / explicit refresh. Metadata only — no keys, no code.
2. Full-graph bootstrap-pull for a roster project with no local graph via
   GET /sync/projects/{id}/graph (no `since`), draining keyset pages like plan 0004 D2. Apply
   as a dumb replica of cloud's merged state — do NOT add a client-side merge engine.
3. cloudLogout clears the roster cache (names must not leak); retain local graphs on disk.
4. New-project creation requires an active workspace_id.

Exit criteria: plan 0006 §G2 Tests — including offline render, multi-page hydrate, and
logout-clears-cache.
```

### G3 — Desktop gates + no-workspace state

```
Milestone: G3 (plan 0006) — apps/desktop: identity + membership gates, no-workspace state,
roster-driven nav.

1. App.tsx: add auth? and membership? gates AHEAD of the onboarding branch (order:
   identity → membership → onboarding). Auth gate = ADR 0014 browser handoff.
2. New no-workspace screen (create/join; invite acceptance stays in apps/web).
3. TopBar.resolveWorkspace() drives the gate, not just a label; KEEP the "cloud unreachable ≠
   no workspaces" distinction (it's the offline state now); remove the signed-out "Local
   workspace" flat view.
4. Workspace.tsx: roster-driven project list; new project requires the active workspace.
5. Put the whole gate behind a feature flag; stub mode relaxes it as today.

Exit criteria: plan 0006 §G3 Tests — all six gate/offline/revocation cases.
```

### G4 — Local-project import

```
Milestone: G4 (plan 0006) — apps/desktop: import existing local-only projects.

A one-time "N local projects aren't in a workspace — import them?" prompt on first gated
launch; link each chosen project to a chosen workspace (reuse linkProjectToCloud + sync). Never
auto-link silently.

Exit criteria: plan 0006 §G4 Tests.
```

### Tips for running these
- One milestone = one branch/PR. G1 and G2 can run in parallel; G3 needs both; G4 last.
- If a session degrades (context bloat, repeated mistakes), start fresh: preamble + milestone
  prompt + "continue from the current branch state" recovers cleanly.
- After each milestone, update this plan's status line and note deviations — the docs are the
  contract for the next session.
