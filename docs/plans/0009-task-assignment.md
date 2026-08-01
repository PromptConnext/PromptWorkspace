# Plan 0009 — Assign tasks to workspace members

**Date:** 2026-07-22 · **Status:** Ready for implementation · **ADR:** [0018](../decisions/0018-assign-tasks-to-workspace-members.md)

This plan implements task assignment to workspace members. It is sequenced so each milestone is independently testable and the first two milestones (M1–M2) form a complete, shippable web-only slice; M3–M4 add desktop display.

**Decisions locked (ADR 0018):** a new **pz-owned** `assigned_user_id` field distinct from the existing pmo `assignee`; a dedicated `PATCH` endpoint stamps it `source="pz"`; **admins assign anyone, any member self-assigns**; **editing is web-only, desktop displays read-only**.

Absolute paths below are relative to the repo root `/Users/kittisak/REPO/ideva/PromptZone`.

---

## Milestone 1 — Cloud: field, migration, endpoint, repository

Goal: the cloud stores an app-authored `assigned_user_id` and exposes a permission-checked endpoint to set/clear it. Both repository backends pass tests with no Supabase required.

### 1.1 Data model — `apps/cloud/app/models/schemas.py`

- On `class Task(GraphEntity)` (currently lines 144–153), add below `sprint`:

  ```python
      # pz-owned: a workspace member's user_id, set by the app (ADR 0018).
      # Distinct from the pmo `assignee` free-text tracker name above.
      assigned_user_id: str | None = None
  ```

- In `FIELD_AUTHORITY["tasks"]` (lines 347–354), add:

  ```python
          "assigned_user_id": "pz",
  ```

  (Declaring it explicitly, though absent fields already default to `pz` — being explicit keeps the hand-synced web mirror honest.)

- Add a request model near the other small request bodies (e.g. after `DiscussionCreate`, ~line 196):

  ```python
  class TaskAssignmentUpdate(BaseModel):
      """Set or clear a task's PromptConnext assignee. `null` unassigns."""
      assigned_user_id: str | None = None
  ```

### 1.2 Migration — `apps/cloud/migrations/0017_task_assigned_user.sql` (new)

Match the additive style of `0004_field_ownership.sql`:

```sql
-- PromptConnext Cloud — task assignment to workspace members (ADR 0018)
--
-- A pz-owned assignee distinct from the pmo `assignee` (a tracker display
-- name). Holds a workspace member's user_id; the app sets it via
-- PATCH /projects/{id}/tasks/{tid}/assignment, merged source="pz".
-- Additive & backward-compatible: existing rows default to NULL (unassigned).

alter table pz_tasks add column if not exists assigned_user_id text;
```

No FK to `auth.users` (that schema is service-role only, same reason `email` is denormalized in `0012`); membership validity is enforced in the endpoint, not the column.

### 1.3 Repository — focused `assign_task`

Add an abstract method to `class Repository` in `apps/cloud/app/db/repository.py` (near `get_task`, ~line 161):

```python
@abc.abstractmethod
def assign_task(
    self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
) -> Task:
    """Single-field pz write of `assigned_user_id`, stamping its field
    version. Raises KeyError if the task doesn't exist."""
```

**`InMemoryRepository.assign_task`** (add near its `get_task`, ~line 630):

```python
def assign_task(
    self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
) -> Task:
    store = self._graph.get(project_id)
    task = store["tasks"].get(task_id) if store else None
    if task is None:
        raise KeyError(task_id)
    versions = dict(task.field_versions or {})
    versions["assigned_user_id"] = {"updated_at": now.isoformat(), "source": "pz"}
    task.assigned_user_id = assigned_user_id
    task.field_versions = versions
    task.updated_at = now
    return copy.deepcopy(task)
```

**`SupabaseRepository.assign_task`** in `apps/cloud/app/db/supabase_repository.py` (near its `get_task`, ~line 392). Read-modify-write the single field + its version, consistent with how `upsert_graph` there merges then upserts:

```python
def assign_task(
    self, project_id: str, task_id: str, assigned_user_id: str | None, now: datetime
) -> Task:
    stored = self._fetch_row("tasks", task_id)
    if stored is None or stored.get("project_id") != project_id:
        raise KeyError(task_id)
    versions = dict(stored.get("field_versions") or {})
    versions["assigned_user_id"] = {"updated_at": now.isoformat(), "source": "pz"}
    self._client.table(_TABLE["tasks"]).update(
        {
            "assigned_user_id": assigned_user_id,
            "field_versions": versions,
            "updated_at": now.isoformat(),
        }
    ).eq("id", task_id).eq("project_id", project_id).execute()
    return self.get_task(project_id, task_id)  # type: ignore[return-value]
```

### 1.4 Endpoint — `apps/cloud/app/api/sync.py`

Add to the existing `sync` router (it already imports `require_project` and has the project/graph routes). Place after `get_project` (~line 68).

```python
from app.models.schemas import TaskAssignmentUpdate, Task, utcnow  # add to imports

@router.patch(
    "/projects/{project_id}/tasks/{task_id}/assignment", response_model=Task
)
def assign_task(
    project_id: str,
    task_id: str,
    body: TaskAssignmentUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Task:
    project = require_project(repo, project_id, user)  # membership-gated
    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    caller_role = repo.get_membership(project.workspace_id, user.id)
    target = body.assigned_user_id

    # Permission: admins assign/clear anyone; a member may only assign a task
    # to themselves or clear a task currently assigned to themselves.
    if caller_role != Role.admin:
        self_assign = target == user.id and target is not None
        self_unassign = target is None and task.assigned_user_id == user.id
        if not (self_assign or self_unassign):
            raise HTTPException(status_code=403, detail="assignment_forbidden")

    # Target must be a current member of the task's workspace (null = unassign).
    if target is not None:
        member_ids = {m.user_id for m in repo.list_members(project.workspace_id)}
        if target not in member_ids:
            raise HTTPException(status_code=400, detail="assignee_not_a_member")

    return repo.assign_task(project_id, task_id, target, utcnow())
```

Add `HTTPException` and `Role` to the imports at the top of `sync.py`.

> **Do not** enqueue a RAG embed job here — `assigned_user_id` is not RAG-indexed content, and the embed enqueue lives only in `push_graph`.

### M1 tests — `apps/cloud/tests/test_task_assignment.py` (new; runs on `InMemoryRepository`)

Follow the shape of `tests/test_sync.py`. Cover:

1. Admin assigns member B to a task → `GET .../graph` shows `assigned_user_id == B`, and `field_versions["assigned_user_id"].source == "pz"`.
2. Member self-assigns → succeeds; `assigned_user_id == self`.
3. Member assigns a *third* member → `403 assignment_forbidden`.
4. Member unassigns their own task (`null`) → succeeds; a member unassigning *someone else's* task → `403`.
5. Assigning a non-member `user_id` → `400 assignee_not_a_member`.
6. Assigning on a non-existent task → `404`.
7. **Coexistence**: a `pmo` graph push setting `assignee="Jira Name"` and a `pz` assignment setting `assigned_user_id` on the same task both persist — neither clears the other (guards ADR 0018 §1).
8. **Non-clobber**: after an assignment, a normal `pz` engine-style graph push that omits `assigned_user_id` leaves it intact.

Run: `cd apps/cloud && pytest tests/test_task_assignment.py -v && ruff check .`

---

## Milestone 2 — Web: editable assignee on the TaskBoard (shippable slice)

Goal: on the Tasks tab, each card shows the current PromptConnext assignee and — for permitted users — a dropdown of workspace members to (re)assign or clear. M1 + M2 is a complete web feature.

### 2.1 Types — `apps/web/src/lib/types.ts`

- Add `assigned_user_id: string | null;` to the `Task` interface (near `assignee`/`sprint`, ~line 70).
- Confirm a `WorkspaceMember` type exists (`workspace_id, user_id, email, role`); add it if missing, mirroring `apps/cloud` `WorkspaceMember`.

### 2.2 Field authority mirror — `apps/web/src/lib/fieldAuthority.ts`

Add `assigned_user_id: "pz",` to `FIELD_AUTHORITY.tasks` (line 8–15). Keep it in lockstep with schemas.py.

### 2.3 API client — `apps/web/src/lib/api.ts`

`apiFetch` already exists. Add thin helpers (or call `apiFetch` directly from the component — match the codebase's existing pattern, which passes `authHeaders()` in at the call site):

```ts
export function listMembers(workspaceId: string, authHeaders: Record<string, string>) {
  return apiFetch<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`, authHeaders);
}

export function assignTask(
  projectId: string,
  taskId: string,
  assignedUserId: string | null,
  authHeaders: Record<string, string>,
) {
  return apiFetch<Task>(
    `/projects/${projectId}/tasks/${taskId}/assignment`,
    authHeaders,
    { method: "PATCH", body: JSON.stringify({ assigned_user_id: assignedUserId }) },
  );
}
```

### 2.4 Board wiring — `apps/web/src/components/project/TaskBoard.tsx` + project page

`TaskBoard` currently takes only `{ graph }` and is fully read-only. It needs: the `projectId`, the `workspaceId`, the members list, the caller's `user.id` and role, and a way to refresh after a write.

- **Project page** `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx`: the `Tasks` tab already has `workspaceId`, `projectId`, and `refetch` in scope. Pass them through:

  ```tsx
  {tab === "Tasks" && (
    <TaskBoard graph={graph} workspaceId={workspaceId} projectId={projectId} onChange={refetch} />
  )}
  ```

- **TaskBoard**: fetch members and derive the caller's role inside the board.
  - `const { user, authHeaders } = useAuth();`
  - Fetch members once: `listMembers(workspaceId, authHeaders())` → `members`; build `byId = new Map(members.map(m => [m.user_id, m]))` for display, and `myRole = byId.get(user.id)?.role`.
  - Replace the read-only assignee chip block (lines 31–35) with an assignee control:
    - Display: if `task.assigned_user_id`, show `byId.get(id)?.email ?? id` as a `pz`-styled chip (indigo, per `AUTHORITY_STYLE.pz`), labelled `· pz` (not `· pmo`).
    - Keep the existing pmo `assignee` chip separately when present (it now represents only the tracker mirror).
    - Editable when `canEdit(task)`: `myRole === "admin" || task.assigned_user_id === user.id || task.assigned_user_id == null`. (A member can self-assign an unassigned task or unassign their own; the server re-checks, so the client gate is UX-only.)
    - Render a `<select>` of members (plus an "Unassigned" option) → on change call `assignTask(projectId, task.id, value || null, authHeaders())` then `onChange()` to refetch. Disable the control while the request is in flight; on `ApiError` show the `detail` inline.

Keep the change minimal and consistent with the board's Tailwind styling; do not restructure the columns.

### M2 tests / verification

There is no web test runner wired for components (the repo's only test suite is `apps/cloud`). Verify by:

1. `pnpm --dir apps/web typecheck` and `pnpm --dir apps/web lint` — must pass.
2. Manual/stub smoke against a local cloud (`AUTH_MODE=stub`): sign in as an admin `X-User-Id`, assign a task, confirm the chip updates and persists across a refetch; sign in as a non-admin member, confirm self-assign works and assigning others is rejected with the inline error.

---

## Milestone 3 — Engine: local column + ongoing assignment pull

Goal: the desktop engine stores and refreshes each task's `assigned_user_id` from the cloud, without disturbing the push-only model for every other task field.

### 3.1 Local schema — `apps/engine/src/db.ts`

The engine has no migration framework; `SCHEMA` is `CREATE TABLE IF NOT EXISTS`, so an added column won't apply to existing DBs. Two parts:

- Add `assigned_user_id TEXT` to the `tasks` `CREATE TABLE` (after `feature_tag`, line 37) for fresh installs.
- Add a forward-only column-ensure after `db.exec(SCHEMA);` (line 131), matching the "first table that needed it" precedent set by discussions:

  ```ts
  // Forward-only column adds for existing DBs (no migration framework).
  function ensureColumn(table: string, column: string, ddl: string): void {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }
  ensureColumn("tasks", "assigned_user_id", "assigned_user_id TEXT");
  ```

### 3.2 Hydrate replica — `apps/engine/src/sync/loop.ts`

- Extend the `CloudGraphPage.tasks` element type (line ~450) with `assigned_user_id: string | null`.
- Extend `upsertTask` (line 484) to include the column:

  ```ts
  const upsertTask = db.prepare(`
    INSERT INTO tasks (id, spec_id, title, status, feature_tag, assigned_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      spec_id = excluded.spec_id, title = excluded.title,
      status = excluded.status, feature_tag = excluded.feature_tag,
      assigned_user_id = excluded.assigned_user_id
  `);
  ```

- In `applyGraphPage` (line 526–541), pass `t.assigned_user_id ?? null` as the sixth bind param.

### 3.3 Ongoing single-field pull — `apps/engine/src/sync/loop.ts`

Mirror `pullProjectDiscussions` exactly, but touch only `assigned_user_id`. Add its own cursor key so it doesn't interfere with the discussions cursor:

```ts
const updateLocalTaskAssignee = db.prepare(
  "UPDATE tasks SET assigned_user_id = ? WHERE id = ?",
);

function assignmentsPullCursorKey(localProjectId: string): string {
  return `assignments_pull_cursor:${localProjectId}`;
}

// Ongoing pull of the one pz-owned field the app writes and the engine never
// pushes (ADR 0018 §5). Reuses the incremental graph endpoint; reads only
// tasks[].assigned_user_id, ignoring every other array (engine stays the
// source of truth for the rest). Narrow, single-field mirror — NOT the general
// pull-and-apply still deferred at the bottom of this file.
export async function pullProjectTaskAssignments(localProjectId: string): Promise<void> {
  const link = getCloudLink(localProjectId);
  if (!link?.project_id) return;
  const cursor = getAppState(assignmentsPullCursorKey(localProjectId));
  const path = cursor
    ? `/sync/projects/${link.project_id}/graph?since=${encodeURIComponent(cursor)}`
    : `/sync/projects/${link.project_id}/graph`;
  const res = await cloudFetch<{
    tasks: { id: string; assigned_user_id: string | null }[];
    cursor: string | null;
  }>(path, { method: "GET" });
  for (const t of res.tasks) {
    // Only updates a row that already exists locally; a task the engine has
    // never seen is created by the normal generate path / hydrate, not here.
    updateLocalTaskAssignee.run(t.assigned_user_id ?? null, t.id);
  }
  if (res.cursor) setAppState(assignmentsPullCursorKey(localProjectId), res.cursor);
}
```

- Call it in `startCloudSyncLoop` (line 404–409) next to the discussions pull:

  ```ts
  await pushProjectSnapshot(projectId).catch(() => {});
  await pullProjectDiscussions(projectId).catch(() => {});
  await pullProjectTaskAssignments(projectId).catch(() => {});
  ```

- **Leave `assembleSnapshot` unchanged** — the push must keep omitting `assigned_user_id` (same rationale as the `assignee`/`sprint` omission at lines 168–169). Update that comment to name `assigned_user_id` too.
- Update the module's closing "Still deliberately not built" note (lines 617–627): the local `tasks` table now *does* have this one pz column and mirrors it via `pullProjectTaskAssignments`; the general incremental pull for the *rest* of the graph remains deferred.

### 3.4 Engine task reads — `apps/engine/src/routes/projects.ts`

Find the graph-read query that selects task columns for the desktop (the `SELECT id, title, status, feature_tag FROM tasks WHERE spec_id = ?` at ~line 674, per the code map) and add `assigned_user_id` to the projection so the desktop receives it. Add `assigned_user_id` to whatever task type the route serializes.

### M3 verification

Engine has no test suite. Verify by:

1. `pnpm --dir apps/engine typecheck` (if configured) or `node --check` on the changed files; the engine runs TS natively — start it (`pnpm engine`) and confirm no runtime error on boot (the `ensureColumn` runs at import).
2. Manual: with a local cloud, assign a task in the web app, run the engine against the same linked project, and confirm the local `tasks.assigned_user_id` updates within one poll interval (`CLOUD_SYNC_POLL_SECONDS`, default 20s). Confirm a subsequent engine push does **not** null the cloud `assigned_user_id`.

---

## Milestone 4 — Desktop: display the assignee + members cache

Goal: the desktop `GraphView` shows who a task is assigned to, resolved to a name.

### 4.1 Workspace-members cache (engine)

The roster (ADR 0015) already mirrors workspaces/projects from the cloud on sign-in/focus. Extend it with members:

- Add a local table (in `apps/engine/src/db.ts` `SCHEMA`):

  ```sql
  CREATE TABLE IF NOT EXISTS workspace_members_cache (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT,
    role TEXT,
    PRIMARY KEY (workspace_id, user_id)
  );
  ```

- Where the roster refresh runs (locate the existing `GET /workspaces` + `GET /projects` roster mirror — search `apps/engine/src` for `"/workspaces"` and the roster/cache module referenced by ADR 0015), also fetch `GET /workspaces/{id}/members` for each workspace and upsert into `workspace_members_cache`.
- On sign-out, clear this table alongside the roster scrub (the same privacy obligation ADR 0015 §3 established for workspace/project names).
- Expose members to the webview: extend the engine route that serves roster/project context so the desktop can resolve `user_id → email`. A minimal option is a `GET /engine/workspaces/:id/members` reading the cache.

### 4.2 Desktop display — `apps/desktop/src/components/GraphView.tsx`

- Add `assigned_user_id` to the task shape in the engine `Graph` type (`apps/desktop/src/api.ts` or wherever `Graph`/task rows are typed).
- Load the members map for the active workspace (via the engine members route) and, on each task node (line ~51, next to the status badge), render a small read-only chip when `task.assigned_user_id` is set: `members.get(id)?.email ?? shortId(id)`. Match the existing `.badge` styling; no click/edit behavior.

### M4 verification

1. `pnpm --dir apps/desktop typecheck`.
2. Manual: assign in web → the desktop `GraphView` shows the assignee name after a roster/members refresh (sign-in/focus) + one assignment-pull interval. Sign out → confirm the members cache is cleared.

---

## Cross-cutting checklist (for the implementing loop)

- **Keep the four authority mirrors in lockstep**: `schemas.py FIELD_AUTHORITY`, `apps/web/src/lib/fieldAuthority.ts`, and the field presence in both `Task` types. `assigned_user_id` is `pz` everywhere.
- **The engine push never sends `assigned_user_id`** — the pull is its sole local writer. Do not add it to `assembleSnapshot`.
- **Server is the source of truth for permission** — the web gate is UX-only; the `PATCH` endpoint re-checks role and membership.
- **`null` means unassigned** end to end (body, column default, chip hidden).
- **Run `ruff check .` and `pytest` in `apps/cloud`** after M1; **typecheck + lint** the touched JS/TS apps after M2/M3/M4.
- **Do not** route assignment through `PUT /sync/.../graph`, and **do not** re-domain the existing `assignee` — both were considered and rejected in ADR 0018.

## Suggested commit sequence

1. `feat(cloud): add pz-owned assigned_user_id + assignment endpoint (M1)` — model, migration 0017, repos, route, tests.
2. `feat(web): editable task assignee on the board (M2)` — types, api, TaskBoard.
3. `feat(engine): mirror task assignments to local SQLite (M3)` — column, hydrate, ongoing pull.
4. `feat(desktop): show task assignee in GraphView + members cache (M4)`.

M1+M2 are releasable on their own; M3+M4 can follow.
