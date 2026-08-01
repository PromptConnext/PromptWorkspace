# Desktop open-in-cloud top bar control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small "open in cloud" control to the desktop top bar that opens the currently-open project's page on the cloud web app, visible only when that project is linked to a cloud workspace.

**Architecture:** The engine already knows `CLOUD_WEB_URL`; expose it through the existing `GET /engine/cloud/config` route the desktop already polls. `Workspace.tsx` already tracks the open project (with its `cloud_workspace_id`/`cloud_project_id`); pass it into `TopBar`, which already renders the project tabs and already imports `openUrl`.

**Tech Stack:** Hono (`apps/engine`), React 18 (`apps/desktop`), `@tauri-apps/plugin-opener`.

## Global Constraints

- No new engine route — reuse `GET /engine/cloud/config` (spec: "No new route").
- Icon-button appears once, next to the tabs row, only when the active tab's project has both `cloud_workspace_id` and `cloud_project_id` set — hidden otherwise (spec: "Hide/disable it").
- Link target: `{webUrl}/w/{cloud_workspace_id}/p/{cloud_project_id}` — the project's default landing page, no sub-tab deep link (spec: "Out of scope").
- Spec: `docs/superpowers/specs/2026-07-19-desktop-open-in-cloud-design.md`.

---

### Task 1: Engine — expose `webUrl` on the cloud config route

**Files:**
- Modify: `apps/engine/src/routes/cloud.ts:39-41`
- Test: `apps/engine/test/g2-roster.test.ts`

**Interfaces:**
- Produces: `GET /engine/cloud/config` now returns `{ enabled: boolean, mode: "stub"|"supabase", webUrl: string }` — `enabled`/`mode` unchanged, `webUrl` new.

- [ ] **Step 1: Write the failing test**

Open `apps/engine/test/g2-roster.test.ts` and add this test right after the existing `test("roster cache renders the last-known workspaces/projects fully offline", ...)` block (it's a good early, state-independent spot — this route doesn't depend on login):

```ts
test("GET /engine/cloud/config exposes the cloud web app URL", async () => {
  const res = await req("/engine/cloud/config");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enabled: boolean; mode: string; webUrl: string };
  assert.equal(body.enabled, true);
  assert.ok(body.webUrl, "webUrl is present and non-empty");
  assert.match(body.webUrl, /^https?:\/\//, "webUrl is a full URL");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test apps/engine/test/g2-roster.test.ts`
Expected: the new test FAILS — `body.webUrl` is `undefined`, so `assert.ok(body.webUrl, ...)` throws.

- [ ] **Step 3: Implement the minimal change**

In `apps/engine/src/routes/cloud.ts`, replace lines 39-41:

```ts
cloud.get("/engine/cloud/config", (c) =>
  c.json({ enabled: Boolean(CLOUD_API_URL), mode: cloudMode(), webUrl: CLOUD_WEB_URL }),
);
```

(`CLOUD_WEB_URL` is already imported at the top of the file — line 4 — for the browser-login route, no new import needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test apps/engine/test/g2-roster.test.ts`
Expected: all tests PASS (the new one plus the eight pre-existing ones — 9 total).

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/routes/cloud.ts apps/engine/test/g2-roster.test.ts
git commit -m "feat(engine): expose the cloud web app URL on GET /engine/cloud/config

Lets the desktop build a link to a project's cloud page without a new
route — CLOUD_WEB_URL was already used server-side for the browser
login redirect."
```

---

### Task 2: Desktop — "open in cloud" button

**Files:**
- Modify: `apps/desktop/src/api.ts:268` (the `CloudConfig` type)
- Modify: `apps/desktop/src/components/Workspace.tsx:176-188` (the `<TopBar .../>` call)
- Modify: `apps/desktop/src/components/TopBar.tsx`
- Modify: `apps/desktop/src/styles.css` (append after the `.tb-tab-new` rule, `styles.css:403-406`)

**Interfaces:**
- Consumes: `GET /engine/cloud/config` now returns `webUrl: string` (Task 1); `Project` type (`api.ts:46-52`) already has `cloud_workspace_id: string | null` and `cloud_project_id: string | null`, unchanged.
- Produces: `TopBar` gains a new required prop `activeProject: Project | null`.

- [ ] **Step 1: Add `webUrl` to the `CloudConfig` type**

In `apps/desktop/src/api.ts`, replace line 268:

```ts
export type CloudConfig = { enabled: boolean; mode: "stub" | "supabase"; webUrl: string };
```

- [ ] **Step 2: Verify the desktop still typechecks**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: no errors (widening a type with a required field only breaks *producers*, and the only producer is the engine response, which Task 1 already updated to match).

- [ ] **Step 3: Pass the active project into `TopBar`**

In `apps/desktop/src/components/Workspace.tsx`, replace the `<TopBar .../>` call (lines 176-188):

```tsx
      <TopBar
        tabs={tabs}
        activeTabKey={activeTabKey}
        activeProject={active}
        onSelectTab={selectTab}
        onCreateProject={create}
        reloadSignal={refreshTick}
        onGateRecheck={onGateRecheck}
        onWorkspaceContextChange={(ctx) => {
          setWorkspaceCtx(ctx);
          void refresh();
          void refreshRoster();
        }}
      />
```

- [ ] **Step 4: Accept the prop and add the button in `TopBar`**

In `apps/desktop/src/components/TopBar.tsx`, add the `Project` type to the existing import from `../api` (replace lines 4-18):

```tsx
import {
  cloudLogin,
  cloudLogout,
  getActiveWorkspace,
  getCloudConfig,
  getCloudSession,
  listCloudWorkspaces,
  redeemBrowserLogin,
  setActiveWorkspace,
  startBrowserLogin,
  type ActiveWorkspace,
  type CloudConfig,
  type CloudSession,
  type CloudWorkspace,
  type Project,
} from "../api";
```

Add `activeProject` to the component's props (replace lines 36-52):

```tsx
export default function TopBar({
  tabs,
  activeTabKey,
  activeProject,
  onSelectTab,
  onCreateProject,
  reloadSignal,
  onWorkspaceContextChange,
  onGateRecheck,
}: {
  tabs: ProjectTab[];
  activeTabKey: string | null;
  activeProject: Project | null;
  onSelectTab: (key: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  reloadSignal: number;
  onWorkspaceContextChange: (ctx: WorkspaceContext) => void;
  onGateRecheck?: () => void;
}) {
```

Add the computed link and the click handler right after `canCreateProject` (after line 287's `const canCreateProject = !connected || Boolean(active);`):

```tsx
  // Only the active project's own cloud page — no workspace-level link, no
  // sub-tab deep link (spec: out of scope). Absent whenever the open project
  // isn't linked yet, or config hasn't loaded.
  const cloudProjectLink =
    config?.webUrl && activeProject?.cloud_workspace_id && activeProject?.cloud_project_id
      ? `${config.webUrl}/w/${activeProject.cloud_workspace_id}/p/${activeProject.cloud_project_id}`
      : null;

  const openInCloud = async () => {
    if (!cloudProjectLink) return;
    try {
      await openUrl(cloudProjectLink);
    } catch (err) {
      setAcctError((err as Error).message);
    }
  };
```

Add the button right after the `tabs.map(...)` block and before the `+ New project` conditional (in the `<nav className="tb-projects">` block, insert after the closing `))}` of `tabs.map` — i.e. right after line 323's `))}` and before line 324's `{!canCreateProject ? (`):

```tsx
        {cloudProjectLink && (
          <button
            type="button"
            className="tb-cloud-link"
            title={`Open "${activeProject?.name}" in the cloud`}
            onClick={openInCloud}
          >
            ↗ Cloud
          </button>
        )}
```

- [ ] **Step 5: Add the CSS**

In `apps/desktop/src/styles.css`, append after the `.tb-tab-new` rule (after line 406's closing `}`):

```css
.tb-cloud-link {
  white-space: nowrap;
  font-size: 0.85em;
  padding: 5px 10px;
  border-radius: 999px;
  color: var(--muted);
}
```

- [ ] **Step 6: Verify it typechecks**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

Run: `pnpm desktop`.

1. Open a project that's linked to a cloud workspace (has both `cloud_workspace_id` and `cloud_project_id`) → the "↗ Cloud" button appears next to the tabs, right before "+ New project".
2. Click it → the system default browser opens to `{webUrl}/w/{workspaceId}/p/{projectId}` and lands on that project's page in the web app.
3. Switch to a local-only/unlinked project → the button disappears.
4. Switch back to the linked project → the button reappears with the correct link (confirms no stale closure/leftover state).

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/components/Workspace.tsx apps/desktop/src/components/TopBar.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): open the active project's cloud page from the top bar

Shows a small 'Cloud' link next to the project tabs whenever the open
project is linked to a cloud workspace, opening its /w/{ws}/p/{proj}
page in the system browser. Hidden for local-only/unlinked projects."
```
