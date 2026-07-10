# Plan — apps/engine: desktop client for the cloud sync API

**Date:** 2026-07-10 · **Status:** Proposed · **Scope:** `apps/engine` (+ `apps/desktop` UI)
**Extends:** ADR 0010 (sync model), ADR 0001 (Tauri shell + Node sidecar)
**Follows:** plan `0001-cloud-deletes-and-auth.md` (M1 deletes, M2 auth/workspaces) and
plan `0002-cloud-conflict-sync-integrations.md` (M3 field ownership, M4 auto-sync,
M5 Jira/ClickUp mirror, M6 presence, M7 ops) — **all seven milestones are shipped**
(see Current baseline below).
**Depth:** implementation-ready · **Sequencing:** Milestones **D1–D4**, see §Sequencing summary.

## Why this is the next milestone

`apps/cloud` is fully built and tested but has **zero consumers**. The desktop
app is Tauri-shell + a local Node/Hono "engine" (`apps/engine`) that owns all
business logic and a local SQLite task graph (`apps/engine/src/db.ts` —
`projects`, `requirements`, `spec_documents`, `tasks`, `acceptance_criteria`,
`artifacts`, `agent_runs`, `integrations`, `stage_states`). Today
collaboration is git-log-only: `syncTasksFromGit`
(`apps/engine/src/routes/projects.ts:547`) infers task status from commit
messages. There is no networking to any cloud service. This plan wires the
engine up as a real client of `apps/cloud`'s sync API.

```
D1 auth + workspace linking ──> D2 push/pull sync loop ──> D3 conflict UI
                                                       └──> D4 presence client
```

## Current baseline (verified against the code on 2026-07-10)

`apps/cloud` git log confirms M1–M7 are shipped and committed (`6ff9bf6` M1
through `4c5e310` M7); `pytest -q` collects 50 passing tests, `ruff check .`
is clean. The API surface D1–D4 build against, verified directly in
`app/api/*.py` and `app/models/schemas.py`:

- **Auth** (`app/dependencies.py`): `AUTH_MODE=stub` (X-User-Id header, tests/
  local dev) or `AUTH_MODE=supabase` (HS256 bearer JWT, `aud=authenticated`,
  identity from `sub`). No login endpoint lives in `apps/cloud` itself —
  Supabase Auth is called directly by the client.
- **Workspaces are now required**, not optional: `POST /projects` takes a
  `workspace_id` and is gated on membership (`app/api/_guards.py`); there is
  no more owner-only project access. A caller must hold at least one
  workspace (`POST /workspaces` or an accepted invitation) before it can
  create a project.
- **Sync** (`app/api/sync.py`): `PUT /sync/projects/{id}/graph` (body carries
  `source: "pz" | "pmo"`), `GET /sync/projects/{id}/graph` (`since`, plus
  **keyset pagination** — `limit`, `after_ts`, `after_id`; response carries
  `next_id`/`has_more`), `GET /sync/projects/{id}/changes` → `ChangesHead
  {cursor, counts, has_changes}`.
- **Field ownership** (`app/models/schemas.py::FIELD_AUTHORITY`,
  `app/db/merge.py`): every `GraphEntity` carries `field_versions`; `tasks`
  fields are `assignee`/`sprint`/`feature_tag` → `pmo`, `status`/
  `acceptance_criteria` → `pz`, `title` → `shared`. A `pmo`-sourced push can
  only ever move `pmo` fields.
- **Rate limiting** (`app/ratelimit.py`): a per-identity token bucket guards
  `/sync/*` and `/api/webhooks/*`; over-limit returns `429` with a
  `Retry-After` header.
- **Presence** (`app/api/presence.py`): `WS /ws/projects/{id}/presence`,
  identified via `?token=<jwt>` in supabase mode or `?user_id=` in stub mode;
  closes `1008` if unauthenticated/non-member, `1013` if the per-project
  connection cap (`WS_MAX_CONNECTIONS_PER_PROJECT`) is hit.
- **Engine side is unchanged from the "why" paragraph above** — no networking
  to `apps/cloud` exists yet in `apps/engine`. This plan is greenfield on the
  client side even though the server side is complete.

## D1 — Auth + workspace linking

### Decision
The engine authenticates to `apps/cloud` as a real Supabase-JWT user (not the
local session-token scheme it uses for the Tauri↔engine hop — that stays
as-is and is unrelated). Reuse the existing credential-storage pattern
(`apps/engine/src/keychain.ts`, macOS Keychain via `security` CLI) rather
than inventing a new secret store.

**Scope: macOS only, no cross-platform keyring work in D1.** Per
`docs/BUILD_AND_DISTRIBUTE.md` §7, the whole desktop app is macOS/Apple-silicon
only today — Windows/Linux have no bundle-node/prebuild handling, no build
target, and the doc already flags "Keychain is macOS-only; a cross-platform
keyring is needed for Windows/Linux" as a known, pre-existing gap unrelated
to cloud sync. Building keyring support for platforms the app can't run on
yet would be wasted work. When a Windows/Linux packaging pass lands (tracked
in BUILD_AND_DISTRIBUTE.md's Limitations, not this plan), cloud session
storage should move to a cross-platform keyring crate/lib as part of that
same pass, not ahead of it.

**`CLOUD_API_URL` is opt-in, disabled by default.** Unset = cloud sync off;
a user must explicitly complete the "Connect to PromptZone Cloud" step below
per project. Most desktop users today are single-player (per
`promptzone-product-roadmap.md`), so this avoids prompting everyone on first
launch for a feature most won't use yet.

### Changes
- **`apps/engine/src/routes/cloud.ts`** (new): `POST /engine/cloud/login`
  (proxies Supabase auth, stores the JWT via `keychain.ts` under
  `credentialRef = "cloud.session"`), `GET /engine/cloud/session` (whoami),
  `POST /engine/cloud/logout`.
- **`apps/engine/src/cloudClient.ts`** (new): thin fetch wrapper around
  `apps/cloud`'s REST API, mirrors `apps/desktop/src/api.ts`'s shape
  (`request<T>`), attaches `Authorization: Bearer <jwt>`, reads
  `CLOUD_API_URL` from config (defaults unset = cloud sync disabled).
- **Workspace step (new, required by cloud's current schema):** after login,
  call `GET /workspaces` — if empty, prompt "create a workspace" (`POST
  /workspaces`, caller becomes admin) or "accept an invite" (`POST
  /invitations/{token}/accept`). Cloud rejects `POST /projects` without a
  `workspace_id`, so this step is not optional and must complete before a
  project can be linked.
- **`integrations` table**: add `kind = 'cloud'` row per project once linked,
  storing `workspace_id` + `project_id` (the cloud-side project this local
  project is bound to) in its existing JSON config column — no schema
  migration needed, this table already models exactly this shape.
- **UI**: extend `apps/desktop/src/components/Onboarding.tsx` /
  `ConnectForm.tsx` pattern with a "Connect to PromptZone Cloud" step (login →
  pick/create workspace → link project); reuses the same connect-form UX
  users already know from model connections.

### Tests
- login stores a JWT the keychain can read back; logout clears it;
- a user with zero workspaces is prompted to create one before project linking
  is offered; `POST /projects` without a resolved `workspace_id` never fires;
- linking a local project writes the `integrations` row; unlinking removes it;
- engine routes reject cloud calls when no session is stored (clear error, not a crash).

## D2 — Push/pull sync loop

### Decision
Mirror `apps/cloud`'s own auto-sync contract (M4): poll
`GET /sync/projects/{id}/changes` on an interval, pull
`GET /sync/projects/{id}/graph?since=...` only when the head advances, push
local deltas via `PUT /sync/projects/{id}/graph` with `source: "pz"`. This is
the same head-check-before-pull design already proven server-side — no new
protocol to invent.

### Changes
- **`apps/engine/src/sync/loop.ts`** (new): background interval (config:
  `CLOUD_SYNC_POLL_SECONDS`, default 20s, only runs when a project has a
  `kind='cloud'` integration row), pause while offline (fetch failure →
  backoff, don't spam).
- **Local dirty tracking**: reuse `updated_at` already on local rows;
  push payload assembled from rows changed since the last successful push
  cursor (stored in `app_state`), tagged `source: "pz"` (the field the
  cloud's merge engine keys on — omitting it defaults to `"pz"` anyway, but
  send it explicitly for clarity).
- **Pull applies to SQLite**: incoming graph entities upsert into the local
  tables using the same per-field-ownership contract the cloud already
  enforces server-side (cloud is the merge authority; the client applies
  whatever it resolves, doesn't need its own merge engine) — client is a
  dumb replica of cloud's merged state for `pz`/`shared` fields it doesn't
  own locally.
- **Keyset pagination**: the engine always passes `limit=500` on pulls
  (comfortably under the server's `le=5000` cap; tune later against real
  project sizes, no reason to block D1 on picking the "perfect" number) and
  drains pages — a response with `has_more: true` is re-fetched with
  `since=<cursor>&after_id=<next_id>` until `has_more` is false — before the
  local apply is considered complete. Never assume a single response.
- **Rate-limit backoff**: a `429` from `/sync/*` carries `Retry-After`
  (seconds) — the poll loop must honor it before retrying rather than
  hot-looping into further 429s.
- **Manual "Sync now"** IPC/HTTP trigger for the git-like mental model
  (README of `apps/cloud` explicitly keeps this even with auto-sync).

### Tests
- push-then-pull round-trips a task through a second simulated client (use
  `apps/cloud`'s in-memory backend in a test harness);
- offline push queues and flushes on reconnect, no data loss;
- poll respects `has_changes: false` and skips the pull (no wasted egress);
- a paginated pull (`has_more: true`) keeps fetching until fully drained
  before applying to SQLite;
- a `429` response pauses the poll loop for `Retry-After` seconds, no
  retry storm.

## D3 — Conflict / field-ownership surfacing in UI

### Decision
Cloud already resolves conflicts server-side (per-field ownership, M3) — the
client doesn't re-decide anything, but users should *see* when a field is
externally owned (e.g. `assignee`/`sprint` mirrored from Jira are read-only
locally) rather than let them edit a field their edit will never win.

**Depth: read-only badges, not a diff view.** A grey-out/badge on the
`pmo`-owned fields is enough to stop a doomed edit; a full "here's what the
tracker overwrote" diff view is real UI surface for a case (concurrent
edit to the same field) that M3's field-scoped ownership already makes rare
by construction — `pz` and `pmo` writers can't even touch the same field, so
there's rarely a diff to show. Build the diff view later only if users
actually ask for it once a Jira/ClickUp mirror is in real use.

### Changes
- Surface `field_versions` (per-field version clocks) and the
  `FIELD_AUTHORITY` domain (`app/models/schemas.py`) on task rows so the
  desktop UI can grey out or badge `pmo`-owned fields (`assignee`, `sprint`,
  `feature_tag`) when a tracker integration is active. `title` is `shared`
  (LWW, editable either way) and needs no badge; `status`/
  `acceptance_criteria` are always `pz` and always locally editable.
- Small affordance only — this is not a new merge UI, just making the
  existing server-side rule visible.

### Tests
- pmo-owned field renders read-only when a Jira/ClickUp link is configured;
  editable when it isn't.

## D4 — Presence client (optional, do last)

### Decision
Connect to `WS /ws/projects/{id}/presence` (M6) only if D1–D3 are stable;
purely cosmetic (who's-viewing avatars), not on the critical path for the
core "my desktop app's task graph now syncs to the team" value.

### Changes
- **`apps/engine/src/sync/presence.ts`** (new): WS client to
  `/ws/projects/{id}/presence`, authenticated the same way as REST calls —
  `?token=<jwt>` in supabase mode, `?user_id=` in stub mode (D1's session
  storage supplies whichever applies) — forwards join/leave/heartbeat to the
  frontend over the existing SSE/WS bridge pattern already used for
  agent-run streaming. Handle close code `1008` (auth/membership rejected —
  surface as "not connected", don't retry-loop) and `1013` (project at
  `WS_MAX_CONNECTIONS_PER_PROJECT` capacity — back off and retry later).

### Tests
- presence roster updates when a second simulated client connects/disconnects.

## Decisions log

Everything previously open is resolved below — nothing blocks starting D1.

| Decision | Resolution | Where specified |
|---|---|---|
| `CLOUD_API_URL` default | Opt-in, disabled by default | D1 Decision |
| Windows/Linux keychain | Scope D1 to macOS only; cross-platform keyring rides along with a future Windows/Linux packaging pass, not this plan | D1 Decision |
| Conflict UI depth (D3) | Read-only badges only, no diff view | D3 Decision |
| Pull page size (D2) | `limit=500` default, tune later | D2 Changes |

None of these are load-bearing enough to warrant re-opening without new
information — revisit only if real usage contradicts the assumption (e.g. a
Windows/Linux build target actually gets scheduled, or users ask for a diff
view once trackers are in real use).

## Sequencing summary
1. **D1** — keystone; nothing else works without a linked, authenticated project.
2. **D2** *(after D1)* — the actual value: local graph and cloud graph converge.
3. **D3** *(after D2)* — polish; prevents silent-loss confusion once a tracker mirror is live.
4. **D4** *(independent, last)* — collaboration nicety, not required for the sync value prop.
