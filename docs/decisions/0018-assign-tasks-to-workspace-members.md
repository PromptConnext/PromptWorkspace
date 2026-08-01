# ADR 0018 — Tasks can be assigned to workspace members via a pz-owned `assigned_user_id`, edited in the web app, displayed on the desktop

**Date:** 2026-07-22 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the decision:** *tasks cannot currently be assigned to workspace members; a task should be assignable to a member of the workspace it belongs to, from the collaborative surface where the team already works.*

**Amends / extends:**

- **ADR 0010** (task-graph sync model) and **M3 field ownership** (`migrations/0004`, `app/db/merge.py`): introduces the first **PromptConnext-native, human-set** field on a task that is neither derived from a stage run nor mirrored from a tracker. It slots into the existing per-field authority model rather than inventing a new mechanism.
- **ADR 0015** (desktop requires workspace membership; cloud-projected roster): reuses the roster identity model — assignment targets are workspace *members*, the same set the roster already knows — and takes the first concrete step across the pull-back gap that ADR flagged as deferred.
- **M2 membership** (`migrations/0003`, `app/api/workspaces.py`): `GET /workspaces/{id}/members` becomes load-bearing for the assignment UI, not just the members admin screen.

---

## Context

### What exists today

The `Task` entity already carries an `assignee: str | None` field (`app/models/schemas.py`), added in M5 for the external-tracker mirror. It is declared **`pmo`** in `FIELD_AUTHORITY`: only a `source="pmo"` writer (the Jira/ClickUp webhook path) may set it, and the merge engine's ownership gate (`merge_entity`, `app/db/merge.py`) silently drops any `source="pz"` write to it. It is a free-text string (a Jira display name), not a reference to a PromptConnext identity. The web `TaskBoard` renders it read-only as an amber "pmo" chip.

Workspace membership is a first-class, RLS-scoped concept: `pz_workspace_members(workspace_id, user_id, role, email)` with `GET /workspaces/{id}/members` returning `WorkspaceMember` rows keyed by `user_id`, with `email` as the human-readable fallback (`auth.users` is only readable by `service_role`, so `email` is denormalized at membership-creation time — migration `0012`).

The desktop engine's local `tasks` table (`apps/engine/src/db.ts`) has **no assignee column at all** — only `id, spec_id, title, status, feature_tag`. The sync loop (`apps/engine/src/sync/loop.ts`) is **push-only for tasks** and deliberately **omits** `assignee`/`sprint` from its snapshot, "so a pz-sourced push can't clobber a tracker mirror." Its closing comment states plainly that ongoing pull-back is not built *precisely because* the local table has no `assignee`/`sprint` columns — "there's nowhere to put the pmo fields a live pull would bring back."

### The problem with reusing `assignee`

The obvious move — let the app write the existing `assignee` field — fails on two counts. First, the field is `pmo`-owned; a web/desktop write is dropped by the merge gate, so nothing would persist unless we re-domain it. Second, even re-domained, `assignee` is a free-text tracker display name; overloading it to also mean "a PromptConnext user id" conflates two different identity spaces on one column, and a workspace with Jira mirroring active would have the app and the webhook fighting over the same cell (last-write-wins churn between a Jira name and a user UUID).

### The tension to resolve

The feature must (a) persist an app-authored assignment through a merge engine that is built to *reject* app writes to tracker-owned fields, (b) reference a stable workspace identity rather than a display string, and (c) reach the desktop for display — which means crossing the pull-back gap ADR 0015 explicitly deferred — without destabilizing the push-only, engine-as-source-of-truth model for every other task field.

---

## Decision

### 1 — A new, pz-owned `assigned_user_id`, distinct from the pmo `assignee`

Add a new task field **`assigned_user_id: str | None`** that holds a workspace member's `user_id`, and declare it **`pz`** in `FIELD_AUTHORITY`. It is the AI-native/collaboration side's own field: the app owns it, the tracker mirror never touches it, and it coexists with the untouched `assignee` string. A task can therefore carry *both* a Jira assignee (mirrored) and a PromptConnext assignee (app-set) without either clobbering the other — the same "each source owns its own field" principle M3 was built for.

Rejected alternative — *re-domain `assignee` to `shared`*: one fewer column, but it fuses tracker identity and PromptConnext identity into a single free-text cell and reintroduces exactly the app-vs-tracker row contention that per-field ownership exists to prevent. Keeping the fields separate is the smaller long-term cost.

### 2 — Assignment is written by a dedicated cloud endpoint, server-stamped `pz`

The web app is a cloud client, not the engine, and today it never mutates the graph. Rather than route assignment through the generic `PUT /sync/.../graph` (which would require the client to resubmit the whole task and would re-stamp unrelated fields), add a **narrow endpoint**:

```
PATCH /projects/{project_id}/tasks/{task_id}/assignment   body: { assigned_user_id: string | null }
```

It resolves the caller, enforces the permission rule (§3), validates the target is a member of the task's workspace, and performs a **single-field write** to `assigned_user_id` — stamping `field_versions["assigned_user_id"] = {updated_at: now, source: "pz"}` and advancing `updated_at`. A `null` body unassigns. Because the write goes through the same field-version machinery, a later `source="pz"` engine push that omits `assigned_user_id` cannot disturb it, and a `pmo` push can never reach it.

### 3 — Permission: admins assign anyone; any member self-assigns

- **Workspace admins** may set `assigned_user_id` to any member of the workspace, or clear it, on any task.
- **Any member** may assign a task **to themselves** and unassign a task **currently assigned to themselves**.
- A member may **not** assign a task to a third party, nor reassign a task away from someone else.

The target `user_id` must be a current member of the task's workspace; assigning to a non-member is a `400`. This mirrors the existing admin/member split already enforced by `require_admin` / `require_workspace` in `app/api/_guards.py`.

### 4 — Editing is web-only; the desktop displays

Per the product decision for this cut, the **editing surface is the web `TaskBoard`**. The desktop app **displays** the current assignee (read-only) so a developer working locally can see who owns a task, but does not edit it. This keeps the desktop's graph surface consistent with its existing "read-only except for comments" posture (ADR 0015, `GraphView.tsx`) and avoids introducing a second write path in the same cut.

### 5 — The desktop learns assignments via a narrow, ongoing pull

Displaying assignments on the desktop requires the engine to *pull* a field the cloud owns — the exact gap ADR 0015 deferred. We cross it **narrowly**, following the precedent M12 set for discussions:

- Add an `assigned_user_id TEXT` column to the engine's local `tasks` table (a small forward-only column add, since the engine has no migration framework — see the plan).
- Add an **ongoing pull** that reuses the existing incremental graph endpoint (`GET /sync/projects/{id}/graph?since=`) and updates **only** `tasks[].assigned_user_id` on local rows — every other task field stays push-only, engine-authoritative, exactly as today. The engine push continues to **omit** `assigned_user_id` (like `assignee`/`sprint`), so the pull is the sole writer of that local column and there is no push/pull round-trip to reconcile.

This is deliberately *not* the general incremental pull-and-apply that ADR 0015 left as a follow-up. It is a single-field mirror of one pz-owned column, the same shape and blast radius as the discussions pull.

To render a name rather than a raw UUID, the desktop resolves `assigned_user_id` against a **workspace-members cache** the engine populates from `GET /workspaces/{id}/members` (the roster already fetches workspace-scoped cloud data on sign-in/focus; members are a small addition to it). Absent a cached match, the desktop falls back to showing a shortened id. This members cache is the one genuinely new piece of desktop plumbing; it is scoped as its own milestone so the web-side feature can ship first.

---

## Options considered (identity & merge)

**A. New pz-owned `assigned_user_id` (chosen).** Clean separation from the tracker mirror, references a stable membership key, slots into M3 field ownership unchanged. Cost: a new column in three places (cloud model + migration, engine local table, web/desktop types) and a members cache on the desktop.

**B. Re-domain the existing `assignee` to `shared`.** Fewest columns, but fuses two identity spaces and reintroduces app-vs-tracker row contention; also breaks the current "assignee is a pmo display name" semantics the web chip relies on. Rejected.

**C. Store assignment outside the task graph** (a separate `pz_task_assignments` table). Maximally decoupled, but it would need its own sync path, its own pull, and its own join on every read — far more machinery than a single owned field on an entity that already syncs. Rejected as over-engineered for a one-field-per-task relationship.

---

## Consequences

**Easier / better**

- **Collaboration lands where the team already is.** The web project surface gains its first task *mutation*, using identity and permission primitives that already exist.
- **No conflict with tracker mirroring.** A workspace can run Jira mirroring and PromptConnext assignment side by side; the two assignees are separate fields.
- **First real step across the pull-back gap** ADR 0015 named — taken narrowly, on a single owned field, so it de-risks the eventual general incremental pull rather than pre-empting it.

**Harder / costs**

- **A new column in four layers** (cloud `Task` + `pz_tasks` migration, engine local `tasks`, web `Task` type + `fieldAuthority`, desktop task shape) that must stay in lockstep — the hand-synced `fieldAuthority.ts` mirror is the easiest to forget.
- **The desktop gains a members cache and an ongoing task pull** — modest, but genuinely new engine surface with its own refresh/scrub lifecycle (members must be cleared on sign-out alongside the roster, same privacy obligation ADR 0015 already established).
- **`email` denormalization staleness** already documented in M12/M2 now also affects assignee display: a member whose email changed upstream shows the cached value until re-invited. Acceptable, and unchanged from today's members screen.

**Revisit when**

- Editing on the desktop is demanded → add the same single-field write path in the engine + a control in `GraphView.tsx`, reusing this endpoint's permission rule.
- The general incremental pull-and-apply (ADR 0015 follow-up) ships → the narrow assignment pull folds into it.
- Assignment needs to drive notifications, filtering ("my tasks"), or workload rollups → those build on `assigned_user_id` without schema change.

---

## What changes, concretely (non-binding implementation map)

- **`apps/cloud`** — add `assigned_user_id` to the `Task` model and to `FIELD_AUTHORITY["tasks"]` (`pz`); migration `0017` adds the `pz_tasks.assigned_user_id` column; a new `PATCH .../tasks/{id}/assignment` route with the admin/self permission rule; a focused `assign_task` repository method on both `InMemoryRepository` and `SupabaseRepository`.
- **`apps/engine`** — add `assigned_user_id` to the local `tasks` table (forward-only column add); include it in the hydrate replica; add an ongoing single-field pull (`pullProjectTaskAssignments`) alongside the discussions pull; add a workspace-members cache fed from `GET /workspaces/{id}/members`.
- **`apps/web`** — add `assigned_user_id` to the `Task` type and `fieldAuthority.ts`; add `assignTask` + `listMembers` to the API client; make the `TaskBoard` card's assignee an editable, permission-gated dropdown of workspace members.
- **`apps/desktop`** — display the resolved assignee on the task node in `GraphView.tsx` (read-only), resolving `assigned_user_id` against the members cache.

---

## Action items

1. [ ] Accept / revise this ADR (esp. §1 new field vs. re-domain, and §5 the narrow ongoing pull + members cache).
2. [ ] Confirm the permission rule (§3): admins-assign-anyone / members-self-assign — and whether unassign-anyone should also be an admin-only power.
3. [ ] Companion plan `docs/plans/0009-task-assignment.md` — sequence cloud → web (shippable slice) → engine/desktop display.
4. [ ] Decide whether "my tasks" filtering ships with this cut or as a fast follow (out of scope here).
