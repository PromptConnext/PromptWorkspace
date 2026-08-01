# Desktop local project path + first-open folder picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a project's local filesystem path in the desktop UI once it has one, and let the user pick (or skip, to the existing default) a local folder the first time a cloud-sourced project is opened on this machine, instead of the engine silently auto-creating one.

**Architecture:** The engine already stores `projects.path` (`NOT NULL UNIQUE`) and `createLocalProjectShell` already accepts an optional explicit path — only the open route never forwards one. Desktop adds a native folder-picker (new `tauri-plugin-dialog` dependency, since none exists in this repo today) that runs only on the first open of a cloud project with no local project yet; every other path (already-opened cloud projects, brand-new local project creation) is untouched.

**Tech Stack:** Hono (`apps/engine`), `node:sqlite`, React 18 (`apps/desktop`), Tauri 2 + `@tauri-apps/plugin-dialog` / `tauri-plugin-dialog`.

## Global Constraints

- No DB schema change — `projects.path` is already `TEXT NOT NULL UNIQUE`.
- Brand-new (non-cloud) project creation (`Workspace.tsx`'s `create()`) keeps its current silent-default path — out of scope.
- No "relocate folder for an already-open project" feature — out of scope.
- No pre-`mkdir` writability probe beyond what `mkdirSync` already surfaces as an error — out of scope.
- Spec: `docs/superpowers/specs/2026-07-19-desktop-local-project-path-design.md`.

---

### Task 1: Engine — honor a caller-supplied path on first cloud-project open

**Files:**
- Modify: `apps/engine/src/routes/cloud.ts:190-208` (the `POST /engine/cloud/projects/:cloudProjectId/open` handler)
- Test: `apps/engine/test/g2-roster.test.ts`

**Interfaces:**
- Consumes: `createLocalProjectShell(name: string, path?: string): ProjectRow` (already exported from `apps/engine/src/routes/projects.ts:74`, unchanged).
- Produces: `POST /engine/cloud/projects/:cloudProjectId/open` now reads an optional JSON body `{ path?: string }`; on a path already used by another project it returns `409` with `{ error: string }` matching `/already used/i`; all other response shapes are unchanged from today (`{ localProjectId, hydrated, ... }` on success, `404`/`401`/`502` unchanged).

- [ ] **Step 1: Write the failing tests**

Open `apps/engine/test/g2-roster.test.ts` and insert two new tests directly after the existing `test("G4: GET /engine/projects surfaces cloud_project_id for a linked project", ...)` block (ends at line 228) and before `test("creating a project without an active workspace is rejected with a clear error", ...)`:

```ts
test("opening a cloud project with an explicit path uses it instead of the default location", async () => {
  cloud.projects.push({ id: "cp-custom-path", name: "Custom Path Project", workspace_id: "ws-1" });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const chosen = join(dataDir, "chosen-folder");
  const res = await req("/engine/cloud/projects/cp-custom-path/open", {
    method: "POST",
    body: JSON.stringify({ path: chosen }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { localProjectId: string };

  const row = db.prepare("SELECT path FROM projects WHERE id = ?").get(body.localProjectId) as {
    path: string;
  };
  assert.equal(row.path, chosen, "the caller-supplied path is used verbatim, not the default root");
});

test("opening a cloud project at a path already used by another project returns 409", async () => {
  const taken = join(dataDir, "chosen-folder"); // claimed by the previous test
  cloud.projects.push({ id: "cp-collide", name: "Collide Project", workspace_id: "ws-1" });
  await req("/engine/cloud/roster/refresh", { method: "POST" });

  const res = await req("/engine/cloud/projects/cp-collide/open", {
    method: "POST",
    body: JSON.stringify({ path: taken }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /already used/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test apps/engine/test/g2-roster.test.ts`
Expected: the two new tests FAIL — the first because the local project lands at the default `~/PromptConnext-Projects/<slug>` path instead of `chosen`, the second because the route currently returns `200`/`502` (raw SQLITE error) instead of `409`.

- [ ] **Step 3: Implement the minimal change**

In `apps/engine/src/routes/cloud.ts`, replace the body of the open route (lines 190-208):

```ts
cloud.post("/engine/cloud/projects/:cloudProjectId/open", async (c) => {
  if (!loadCloudSession()) return c.json({ error: "not logged in to PromptConnext Cloud" }, 401);
  const cloudProjectId = c.req.param("cloudProjectId");

  const existing = findLocalProjectByCloudId(cloudProjectId);
  if (existing) return c.json({ localProjectId: existing, hydrated: false });

  const rosterProject = loadRosterProjects().find((p) => p.id === cloudProjectId);
  if (!rosterProject) return c.json({ error: "project not in roster (refresh first)" }, 404);

  // The desktop offers a folder picker on first open (plan: docs/superpowers/
  // plans/2026-07-19-desktop-local-project-path.md); omitted, this falls back
  // to createLocalProjectShell's own default root, same as before.
  const { path } = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });

  let local: ReturnType<typeof createLocalProjectShell>;
  try {
    local = createLocalProjectShell(rosterProject.name, path?.trim() || undefined);
  } catch (err) {
    const message = (err as Error).message;
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ error: "That folder is already used by another project." }, 409);
    }
    return c.json({ error: message }, 500);
  }

  writeCloudLink(local.id, { workspace_id: rosterProject.workspace_id, project_id: cloudProjectId });
  try {
    const result = await hydrateProjectGraph(local.id, cloudProjectId);
    return c.json({ localProjectId: local.id, hydrated: true, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test apps/engine/test/g2-roster.test.ts`
Expected: all tests PASS (the two new ones plus the six pre-existing ones — 8 total).

- [ ] **Step 5: Commit**

```bash
git add apps/engine/src/routes/cloud.ts apps/engine/test/g2-roster.test.ts
git commit -m "feat(engine): honor a caller-supplied path when opening a cloud project locally

Forwards an optional path through to createLocalProjectShell instead of
always falling back to the default ~/PromptConnext-Projects root, and
turns a path collision (UNIQUE constraint) into a clear 409 instead of
a raw 500."
```

---

### Task 2: Desktop — add the native folder-picker dependency

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: `@tauri-apps/plugin-dialog`'s `open()` function becomes importable from `apps/desktop/src` (`import { open } from "@tauri-apps/plugin-dialog"`), and the main window is granted permission to call it. No behavior changes yet — this task only wires the dependency; Task 3 is the first consumer.

- [ ] **Step 1: Add the JS package**

Run: `pnpm --dir apps/desktop add @tauri-apps/plugin-dialog`
Expected: `apps/desktop/package.json`'s `dependencies` gains `"@tauri-apps/plugin-dialog": "^2.x.x"` (matching the `^2.1.0`-style pin already used by the other `@tauri-apps/plugin-*` entries), and the workspace lockfile updates.

- [ ] **Step 2: Add the Rust crate**

In `apps/desktop/src-tauri/Cargo.toml`, add one line to `[dependencies]` (after the existing `tauri-plugin-process = "2"` line), matching the existing plain-version style:

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 3: Register the plugin**

In `apps/desktop/src-tauri/src/lib.rs`, add the plugin registration to the builder chain, directly after `.plugin(tauri_plugin_process::init())` (line 80) and before `.setup(move |app| {` (line 81):

```rust
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 4: Grant the permission**

In `apps/desktop/src-tauri/capabilities/default.json`, add `"dialog:default"` to the `permissions` array so it reads:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default", "opener:default", "updater:default", "process:default", "dialog:default"]
}
```

- [ ] **Step 5: Verify it builds**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: no errors (the new package isn't imported anywhere yet, so this just confirms the install didn't break the existing build).

Run: `cd apps/desktop/src-tauri && cargo check && cd -`
Expected: `Compiling promptconnext-desktop-lib ...` then `Finished` with no errors — confirms the new crate resolves and the plugin registration compiles.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/pnpm-lock.yaml apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json
git commit -m "chore(desktop): add tauri-plugin-dialog for the native folder picker"
```

(If the repo's lockfiles live elsewhere — e.g. a root `pnpm-lock.yaml` instead of a per-app one, or `Cargo.lock` is gitignored — adjust the `git add` paths to whatever `git status` actually shows changed; don't force-add files that weren't touched.)

---

### Task 3: Desktop — first-open folder picker + local path display

**Files:**
- Modify: `apps/desktop/src/api.ts:413-425`
- Create: `apps/desktop/src/components/CloudOpenPanel.tsx`
- Modify: `apps/desktop/src/components/Workspace.tsx`
- Modify: `apps/desktop/src/styles.css` (append near the `.import-*` rules, after line 291's `.import-list` block or the following `.import-row` block — wherever that block ends)

**Interfaces:**
- Consumes: `open({ directory, multiple, title }): Promise<string | string[] | null>` from `@tauri-apps/plugin-dialog` (Task 2); `Project` type (`api.ts:46-52`, unchanged); `RosterProject = { id: string; name: string; workspace_id: string }` (`api.ts:392`, unchanged).
- Produces: `openCloudProject(cloudProjectId: string, path?: string): Promise<OpenCloudProjectResult>` (path now optional second arg); `CloudOpenPanel` component with props `{ projectName: string; busy: boolean; onChooseFolder: (path: string) => void; onUseDefault: () => void }`.

- [ ] **Step 1: Extend `openCloudProject` to accept a path**

In `apps/desktop/src/api.ts`, replace lines 421-425:

```ts
export const openCloudProject = (cloudProjectId: string, path?: string) =>
  request<OpenCloudProjectResult>(
    `/engine/cloud/projects/${encodeURIComponent(cloudProjectId)}/open`,
    { method: "POST", body: JSON.stringify(path ? { path } : {}) },
  );
```

- [ ] **Step 2: Verify the existing desktop build still typechecks**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: no errors (the new second parameter is optional, so every existing call site — `Workspace.tsx`'s current single-arg call — still compiles).

- [ ] **Step 3: Create the picker panel component**

Create `apps/desktop/src/components/CloudOpenPanel.tsx`:

```tsx
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

// First-open gate for a cloud project that has never been opened on this
// machine (plan: docs/superpowers/plans/2026-07-19-desktop-local-project-path.md).
// Shown instead of CloudConnect/ThreeS until the user picks a folder or
// explicitly accepts the default — never auto-created silently.
export default function CloudOpenPanel({
  projectName,
  busy,
  onChooseFolder,
  onUseDefault,
}: {
  projectName: string;
  busy: boolean;
  onChooseFolder: (path: string) => void;
  onUseDefault: () => void;
}) {
  const [pickerBusy, setPickerBusy] = useState(false);

  const chooseFolder = async () => {
    setPickerBusy(true);
    try {
      const dir = await open({
        directory: true,
        multiple: false,
        title: `Choose a folder for "${projectName}"`,
      });
      if (typeof dir === "string") onChooseFolder(dir);
    } finally {
      setPickerBusy(false);
    }
  };

  return (
    <section className="cloud-open-panel">
      <div className="import-head">
        <strong>Where should &quot;{projectName}&quot; live on this computer?</strong>
      </div>
      <p className="muted">
        This project syncs from the cloud. Choose a folder for its files, or use the default
        location.
      </p>
      <div className="cloud-open-actions">
        <button type="button" disabled={busy || pickerBusy} onClick={chooseFolder}>
          {pickerBusy ? "Choosing…" : "Choose folder…"}
        </button>
        <button type="button" disabled={busy || pickerBusy} onClick={onUseDefault}>
          {busy ? "Opening…" : "Use default location"}
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Wire the panel + path display into `Workspace.tsx`**

In `apps/desktop/src/components/Workspace.tsx`:

Replace the import block (lines 1-15):

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  getCloudRoster,
  listProjects,
  openCloudProject,
  refreshCloudRoster,
  type CloudRoster,
  type Project,
} from "../api";
import ThreeS from "./ThreeS";
import CloudConnect from "./CloudConnect";
import CloudOpenPanel from "./CloudOpenPanel";
import ImportLocalProjects from "./ImportLocalProjects";
import TopBar, { type ProjectTab, type WorkspaceContext } from "./TopBar";
import { membershipGateEnabled } from "../cloudGate";
```

Add a `pendingCloudOpen` state next to the existing `openError` state (after line 33's `const [openError, setOpenError] = useState<string | null>(null);`):

```tsx
  const [pendingCloudOpen, setPendingCloudOpen] = useState<
    { key: string; cloudId: string; name: string } | null
  >(null);
  const [openBusy, setOpenBusy] = useState(false);
```

Replace `selectTab` (lines 100-122) with a split that only shows the panel on a true first open, plus the shared finish handler:

```tsx
  // Resolve a tab selection to a usable local project. A cloud tab that's
  // already been opened before is idempotent/instant (unchanged); a cloud tab
  // with no local project yet pauses on a folder-picker panel instead of
  // silently materializing one at the default path. A local tab is already
  // local.
  const selectTab = async (key: string) => {
    setOpenError(null);
    if (key.startsWith("local:")) {
      const id = key.slice("local:".length);
      const p = projects.find((x) => x.id === id) ?? null;
      if (p) {
        setActive(p);
        setActiveKey(key);
        setPendingCloudOpen(null);
      }
      return;
    }
    const cloudId = key.slice("cloud:".length);
    const alreadyLocal = projects.some((p) => p.cloud_project_id === cloudId);
    if (alreadyLocal) {
      await finishCloudOpen(cloudId, key);
      return;
    }
    const rosterProject = roster.projects.find((p) => p.id === cloudId);
    setActive(null);
    setActiveKey(key);
    setPendingCloudOpen({ key, cloudId, name: rosterProject?.name ?? "this project" });
  };

  // Shared by the already-opened fast path above and both CloudOpenPanel
  // actions below — `path` is omitted for "Use default location".
  const finishCloudOpen = async (cloudId: string, key: string, path?: string) => {
    setOpenBusy(true);
    setOpenError(null);
    try {
      const { localProjectId } = await openCloudProject(cloudId, path);
      const r = await listProjects();
      setProjects(r.projects);
      const p = r.projects.find((x) => x.id === localProjectId) ?? null;
      setActive(p);
      setActiveKey(key);
      setPendingCloudOpen(null);
    } catch (err) {
      setOpenError((err as Error).message);
    } finally {
      setOpenBusy(false);
    }
  };
```

Add `setPendingCloudOpen(null);` to `create()` (after line 128's `const project = await createProject(name);`), so switching to a brand-new local project never leaves a stale picker panel behind:

```tsx
  const create = async (name: string) => {
    const project = await createProject(name);
    setPendingCloudOpen(null);
    await refresh();
    await refreshRoster();
    setActive(project);
    setActiveKey(`local:${project.id}`);
  };
```

Replace the `content` div (lines 161-185) to render the panel ahead of the path row/`CloudConnect`/`ThreeS`:

```tsx
      <div className="content">
        {showImport && (
          <ImportLocalProjects
            localOnly={localOnlyProjects}
            workspaces={roster.workspaces}
            onImported={() => {
              void refresh();
              void refreshRoster();
            }}
          />
        )}
        {openError && <p className="error">{openError}</p>}
        {pendingCloudOpen ? (
          <CloudOpenPanel
            projectName={pendingCloudOpen.name}
            busy={openBusy}
            onChooseFolder={(path) =>
              finishCloudOpen(pendingCloudOpen.cloudId, pendingCloudOpen.key, path)
            }
            onUseDefault={() => finishCloudOpen(pendingCloudOpen.cloudId, pendingCloudOpen.key)}
          />
        ) : active ? (
          <>
            <p
              className="project-path"
              title="Click to copy"
              onClick={() => void navigator.clipboard.writeText(active.path)}
            >
              {active.path}
            </p>
            <CloudConnect
              key={active.id}
              projectId={active.id}
              onChange={() => setRefreshTick((t) => t + 1)}
            />
            <ThreeS key={active.id} project={active} />
          </>
        ) : (
          <p className="muted">Select or create a project to start the 3S flow.</p>
        )}
      </div>
```

- [ ] **Step 5: Add the CSS**

In `apps/desktop/src/styles.css`, append after the `.import-row` block (the block that starts at line 293 — find its closing `}` and add these rules directly after it):

```css
.cloud-open-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 20px;
  display: grid;
  gap: 10px;
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}

.cloud-open-actions {
  display: flex;
  gap: 8px;
}

.project-path {
  margin: 0 0 12px;
  font-size: 0.85em;
  cursor: pointer;
}
```

- [ ] **Step 6: Verify it typechecks**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

Run: `pnpm desktop` (engine + Tauri window + hot reload).

Walk through, in a workspace with at least one cloud project never opened on this machine (or create one from the web app / another device first so it shows up in the roster but not locally):

1. Click that project's tab for the first time → the content pane shows the `CloudOpenPanel` ("Where should ... live on this computer?"), the tab itself is highlighted, no folder is created yet.
2. Click "Choose folder…" → the native macOS/Windows folder picker opens; pick a folder → the panel closes, `ThreeS`/`CloudConnect` render, and the path row above them shows the picked folder.
3. Cancel the native dialog instead → the panel stays put, nothing happens.
4. Click a different tab and back to the same cloud project → since it now has a local project, it opens straight through with no panel (the "already opened" fast path).
5. Open a *second*, still-never-opened cloud project and click "Use default location" → it opens at `~/PromptConnext-Projects/<slug>` (today's behavior), and the path row reflects that.
6. Click on the path row → confirm it copies to the clipboard (paste somewhere to check).
7. Create a brand-new local project via the "+" — confirm it opens directly with no panel (unaffected by this change) and its path row renders too.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/api.ts apps/desktop/src/components/CloudOpenPanel.tsx apps/desktop/src/components/Workspace.tsx apps/desktop/src/styles.css
git commit -m "feat(desktop): show a project's local path and pick a folder on first cloud open

Cloud projects opened for the first time on this machine now pause on a
folder-picker panel (skippable to the existing default location) instead
of silently materializing a directory. Once a project has a local path,
it's shown above the 3S content pane."
```
