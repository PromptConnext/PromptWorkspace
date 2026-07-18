# Workspace Part 4 — Desktop Active-Workspace + Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a persisted active-workspace concept to the desktop app (which has none today), a post-cloud-login gate/picker, and scope the local project list to the active workspace by cloud-link, with an "unassigned" bucket for unlinked local projects.

**Architecture:** The engine stores the active workspace in `app_state` (independent of the cloud session, so it survives re-auth), exposes get/put/delete routes, and annotates the local projects list with each project's cloud-linked `workspace_id`. The desktop shell resolves the active workspace after cloud login (remember-last → auto-enter single → picker many) and groups the project list by that workspace. Local-first is preserved: unlinked projects stay usable, and cloud being down never blocks local work. Engine has **no test suite** (verify via `tsc --noEmit`); desktop verifies via `tsc --noEmit` (now clean after the packageExtensions fix).

**Tech Stack:** Node 24 / Hono / TypeScript (engine, `node:sqlite` app_state), Tauri 2 React 18 webview (desktop).

## Global Constraints

- Active workspace persists in engine `app_state` under key `active_workspace` as JSON `{ id, name }`; cleared on cloud logout (`clearCloudSession`).
- `PUT /engine/cloud/active-workspace` validates the id against the caller's cloud memberships (`cloudFetch("/workspaces")`) → 400 if not a member.
- Gate resolution mirrors web: 0 memberships → prompt to create; exactly 1 → auto-enter; >1 → picker; remembered valid id → auto-resume. The gate only applies once cloud is connected — single-player (no cloud) desktop is unchanged.
- Local project list groups by cloud-link: projects linked to the active workspace shown first; unlinked under "Local / unassigned"; projects linked to OTHER workspaces hidden while that workspace isn't active. Unlinked local projects always remain usable, even with cloud offline.
- New cloud-link writes default `workspaceId` to the active workspace when the caller omits it.
- Match existing engine route style (Hono, `c.json`) and desktop component style. Do not add a test runner.

---

### Task 1: Engine — active-workspace state + routes

**Files:**
- Modify: `apps/engine/src/cloudClient.ts` (active-workspace app_state helpers; clear on logout)
- Modify: `apps/engine/src/routes/cloud.ts` (GET/PUT/DELETE routes)

**Interfaces:**
- Produces on `cloudClient.ts`: `ActiveWorkspace = { id: string; name: string }`; `loadActiveWorkspace(): ActiveWorkspace | null`; `storeActiveWorkspace(ws: ActiveWorkspace): void`; `clearActiveWorkspace(): void`. `clearCloudSession()` also clears it.
- Routes: `GET /engine/cloud/active-workspace` → `ActiveWorkspace | null`; `PUT` body `{ id }` → `ActiveWorkspace` (400 if not a member); `DELETE` → `{ ok: true }`.

- [ ] **Step 1: Add active-workspace helpers to cloudClient.ts**

In `apps/engine/src/cloudClient.ts`, near the session helpers (`loadCloudSession`/`storeCloudSession`/`clearCloudSession`), add — reusing the `getAppState`/`setAppState` already imported from `./db.ts`:

```typescript
const ACTIVE_WS_KEY = "active_workspace";

export type ActiveWorkspace = { id: string; name: string };

export function loadActiveWorkspace(): ActiveWorkspace | null {
  const raw = getAppState(ACTIVE_WS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveWorkspace;
  } catch {
    return null;
  }
}

export function storeActiveWorkspace(ws: ActiveWorkspace): void {
  setAppState(ACTIVE_WS_KEY, JSON.stringify(ws));
}

export function clearActiveWorkspace(): void {
  setAppState(ACTIVE_WS_KEY, JSON.stringify(null));
}
```

Then, in the existing `clearCloudSession()` function body, add a call so logout drops the active workspace too:

```typescript
export function clearCloudSession(): void {
  deleteSecret(SESSION_CRED);
  deleteSecret(REFRESH_CRED);
  setAppState(SESSION_KEY, JSON.stringify(null));
  setAppState(ACTIVE_WS_KEY, JSON.stringify(null)); // active workspace is tied to the session
}
```

- [ ] **Step 2: Add the routes to cloud.ts**

In `apps/engine/src/routes/cloud.ts`, update the import from `../cloudClient.ts` to add `loadActiveWorkspace, storeActiveWorkspace` (and `ActiveWorkspace` type), then add these routes near the other `/engine/cloud/*` session routes (after `/engine/cloud/workspaces`):

```typescript
cloud.get("/engine/cloud/active-workspace", (c) => c.json(loadActiveWorkspace()));

cloud.put("/engine/cloud/active-workspace", async (c) => {
  const body = await c.req.json<{ id?: string }>();
  const id = body.id?.trim();
  if (!id) return c.json({ error: "id is required" }, 400);
  try {
    // Validate membership against the caller's cloud workspaces before storing.
    const workspaces = await cloudFetch<{ id: string; name: string }[]>("/workspaces");
    const ws = workspaces.find((w) => w.id === id);
    if (!ws) return c.json({ error: "not a member of that workspace" }, 400);
    const active: ActiveWorkspace = { id: ws.id, name: ws.name };
    storeActiveWorkspace(active);
    return c.json(active);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

cloud.delete("/engine/cloud/active-workspace", (c) => {
  clearActiveWorkspace();
  return c.json({ ok: true });
});
```

Ensure `clearActiveWorkspace` is added to the `../cloudClient.ts` import list too.

- [ ] **Step 3: Typecheck**

Run: `cd apps/engine && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/engine/src/cloudClient.ts apps/engine/src/routes/cloud.ts
git commit -m "feat(engine): persisted active-workspace state + get/put/delete routes"
```

---

### Task 2: Engine — annotate projects with cloud_workspace_id + default link

**Files:**
- Modify: `apps/engine/src/routes/projects.ts` (annotate the list)
- Modify: `apps/engine/src/routes/cloud.ts` (default cloud-link workspace to active)

**Interfaces:**
- Produces: `GET /engine/projects` items gain `cloud_workspace_id: string | null` (the workspace each project is cloud-linked to, or null). `POST /engine/projects/:id/cloud-link` with no `workspaceId` uses the active workspace.

- [ ] **Step 1: Annotate the projects list**

In `apps/engine/src/routes/projects.ts`, replace the `GET /engine/projects` handler so each project carries its cloud-link workspace id. The cloud link lives in `integrations` (kind `cloud`) with a JSON `config` `{ workspace_id, project_id }`:

```typescript
projects.get("/engine/projects", (c) => {
  const rows = db
    .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at")
    .all() as { id: string; name: string; path: string; created_at: string }[];
  const links = db
    .prepare("SELECT project_id, config FROM integrations WHERE kind = 'cloud'")
    .all() as { project_id: string; config: string | null }[];
  const wsByProject = new Map<string, string>();
  for (const l of links) {
    if (!l.config) continue;
    try {
      const cfg = JSON.parse(l.config) as { workspace_id?: string };
      if (cfg.workspace_id) wsByProject.set(l.project_id, cfg.workspace_id);
    } catch {
      // ignore malformed link config
    }
  }
  const projectsOut = rows.map((r) => ({
    ...r,
    cloud_workspace_id: wsByProject.get(r.id) ?? null,
  }));
  return c.json({ projects: projectsOut });
});
```

- [ ] **Step 2: Default the cloud-link workspace to the active one**

In `apps/engine/src/routes/cloud.ts`, in the `POST /engine/projects/:id/cloud-link` handler, where it currently requires `body.workspaceId`, fall back to the stored active workspace. Find the guard that returns `"workspaceId is required"` and change the resolution so an omitted `workspaceId` uses `loadActiveWorkspace()`:

```typescript
  const body = await c.req.json<{ workspaceId?: string; cloudProjectId?: string }>();
  const workspaceId = body.workspaceId?.trim() || loadActiveWorkspace()?.id;
  if (!workspaceId) {
    return c.json({ error: "workspaceId is required (no active workspace set)" }, 400);
  }
```

Then use `workspaceId` (instead of `body.workspaceId`) in the rest of that handler (the cloud project creation `workspace_id` and the stored `CloudLinkConfig.workspace_id`). `loadActiveWorkspace` must be in the `../cloudClient.ts` import list.

- [ ] **Step 3: Typecheck**

Run: `cd apps/engine && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/engine/src/routes/projects.ts apps/engine/src/routes/cloud.ts
git commit -m "feat(engine): annotate projects with cloud_workspace_id, default link to active workspace"
```

---

### Task 3: Desktop — api bindings + workspace resolution/switcher

**Files:**
- Modify: `apps/desktop/src/api.ts` (bindings + `Project` type gains `cloud_workspace_id`)
- Create: `apps/desktop/src/components/WorkspaceBar.tsx`
- Modify: `apps/desktop/src/components/Workspace.tsx` (mount the bar)

**Interfaces:**
- Consumes: Task 1 routes. Produces: a `WorkspaceBar` that, when cloud is connected, resolves the active workspace (remember-last → auto-enter single → picker many) and lets the user switch; calls a parent callback with the active workspace id so the project list can scope (Task 4).

- [ ] **Step 1: api.ts bindings + Project annotation**

In `apps/desktop/src/api.ts`:

```typescript
// Project gains its cloud-linked workspace id (null when unlinked) — see engine
// GET /engine/projects annotation.
export type Project = { id: string; name: string; path: string; cloud_workspace_id: string | null };

export type ActiveWorkspace = { id: string; name: string };

export const getActiveWorkspace = () =>
  request<ActiveWorkspace | null>("/engine/cloud/active-workspace");

export const setActiveWorkspace = (id: string) =>
  request<ActiveWorkspace>("/engine/cloud/active-workspace", {
    method: "PUT",
    body: JSON.stringify({ id }),
  });

export const clearActiveWorkspace = () =>
  request<{ ok: boolean }>("/engine/cloud/active-workspace", { method: "DELETE" });
```

(Update the existing `Project` type in place — don't duplicate it.)

- [ ] **Step 2: WorkspaceBar component**

```tsx
// apps/desktop/src/components/WorkspaceBar.tsx
import { useEffect, useState } from "react";
import {
  getActiveWorkspace,
  getCloudSession,
  listCloudWorkspaces,
  setActiveWorkspace,
  type ActiveWorkspace,
  type CloudWorkspace,
} from "../api";

// Resolves and displays the active cloud workspace once the app is connected to
// cloud. Local-only (not connected) → renders nothing, desktop is unchanged.
// remember-last → auto-enter single → picker for many.
export default function WorkspaceBar({
  onActiveChange,
}: {
  onActiveChange: (id: string | null) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [active, setActive] = useState<ActiveWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    const session = await getCloudSession();
    if (!session.connected) {
      setConnected(false);
      onActiveChange(null);
      return;
    }
    setConnected(true);
    const [stored, ws] = await Promise.all([
      getActiveWorkspace().catch(() => null),
      listCloudWorkspaces().then((r) => r.workspaces).catch(() => []),
    ]);
    setWorkspaces(ws);
    // remember-last: stored active still a membership?
    if (stored && ws.some((w) => w.id === stored.id)) {
      setActive(stored);
      onActiveChange(stored.id);
      return;
    }
    // auto-enter a single membership
    if (ws.length === 1) {
      await select(ws[0].id);
      return;
    }
    // else: leave unset -> picker renders below
    setActive(null);
    onActiveChange(null);
  };

  const select = async (id: string) => {
    setError(null);
    try {
      const a = await setActiveWorkspace(id);
      setActive(a);
      onActiveChange(a.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    resolve().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!connected) return null;

  return (
    <div className="workspace-bar">
      {active ? (
        <label>
          Workspace
          <select value={active.id} onChange={(e) => select(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      ) : workspaces.length === 0 ? (
        <p className="muted">No cloud workspaces yet. Create one below to start syncing.</p>
      ) : (
        <label>
          Select a workspace
          <select value="" onChange={(e) => e.target.value && select(e.target.value)}>
            <option value="">Choose…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Mount the bar in Workspace.tsx and hold the active workspace id**

In `apps/desktop/src/components/Workspace.tsx`, add state for the active workspace id and render `<WorkspaceBar>` at the top of the `<aside>` (above the projects list). Import it. The `onActiveChange` sets a state value Task 4 uses to group the list:

```tsx
import WorkspaceBar from "./WorkspaceBar";
// ...inside Workspace():
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
// ...at the top of <aside>:
      <WorkspaceBar
        onActiveChange={(id) => {
          setActiveWorkspaceId(id);
          void refresh();
        }}
      />
```

(`activeWorkspaceId` is consumed in Task 4's grouping. For this task it can be unused if the executor prefers to add it in Task 4 — but wiring it here keeps the bar's callback meaningful. If leaving it unused trips the build's lint, add it together with Task 4.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: clean (0 errors — the packageExtensions fix cleared the prior monaco error).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/components/WorkspaceBar.tsx apps/desktop/src/components/Workspace.tsx
git commit -m "feat(desktop): workspace bar — resolve/switch active workspace after cloud login"
```

---

### Task 4: Desktop — group the project list by workspace

**Files:**
- Modify: `apps/desktop/src/components/Workspace.tsx` (group projects)

**Interfaces:**
- Consumes: `Project.cloud_workspace_id` (Task 2) + `activeWorkspaceId` (Task 3).

- [ ] **Step 1: Group the project list**

In `apps/desktop/src/components/Workspace.tsx`, replace the flat projects `<ul>` with two groups derived from `activeWorkspaceId`:
- **In the active workspace**: `cloud_workspace_id === activeWorkspaceId` (only when `activeWorkspaceId` is set).
- **Local / unassigned**: `cloud_workspace_id === null`.
- Projects linked to a *different* workspace are hidden while that workspace isn't active.

When `activeWorkspaceId` is `null` (cloud not connected / none selected), show ALL projects flat (current behavior) so local-only usage is unchanged.

```tsx
  const inActive = activeWorkspaceId
    ? projects.filter((p) => p.cloud_workspace_id === activeWorkspaceId)
    : [];
  const unassigned = projects.filter((p) => p.cloud_workspace_id === null);
  const grouped = activeWorkspaceId !== null;

  const renderProject = (p: Project) => (
    <li key={p.id}>
      <button
        type="button"
        className={active?.id === p.id ? "active" : ""}
        onClick={() => setActive(p)}
      >
        {p.name}
      </button>
    </li>
  );
```

And the list markup:

```tsx
        {grouped ? (
          <>
            <ul className="projects">{inActive.map(renderProject)}</ul>
            {unassigned.length > 0 && (
              <>
                <h3 className="muted">Local / unassigned</h3>
                <ul className="projects">{unassigned.map(renderProject)}</ul>
              </>
            )}
          </>
        ) : (
          <ul className="projects">{projects.map(renderProject)}</ul>
        )}
```

(Replace the existing single `<ul className="projects">…</ul>`.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/Workspace.tsx
git commit -m "feat(desktop): group project list by active workspace with Local/unassigned bucket"
```

---

## Self-Review notes (for the executor)

- Spec coverage: active-workspace state + routes (Task 1) ✓; project annotation + default link (Task 2) ✓; resolve/gate/switcher after cloud login, remember-last/auto-enter/picker (Task 3) ✓; list grouping with unassigned bucket + local-first fallback (Task 4) ✓.
- Local-first: `WorkspaceBar` renders nothing when cloud isn't connected, and the list falls back to flat/all-projects when `activeWorkspaceId` is null — offline/unlinked work never blocked.
- Membership validation lives server-side in the engine `PUT` (via `cloudFetch("/workspaces")`), so an invalid id is rejected regardless of the UI.
- Type consistency: `Project.cloud_workspace_id` is set by the engine annotation (Task 2) and consumed by the desktop grouping (Task 4); `ActiveWorkspace {id,name}` is identical across engine helpers, routes, and the desktop bindings.
- No test runner in engine/desktop — gates are `tsc --noEmit` (both now clean).
