# ADR 0016 M1 — Planner Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the existing 3S flow into a TopBar-reachable "Planner" surface, and tidy the existing per-project tabs into a business-facing cluster (Planner, Task Graph) versus a developer-facing cluster (Editor, Terminal) — no new backend, no new components, pure UI reshuffle in `apps/desktop`.

**Architecture:** `TopBar.tsx` gains a "✦ Planner" button that increments a signal counter (mirrors the existing `reloadSignal` pattern already used for roster refresh). `Workspace.tsx` owns that counter and threads it down to `ThreeS.tsx`, which resets its internal tab state to the Planner tab whenever the signal changes. `ThreeS.tsx`'s own tab nav gets relabeled and visually regrouped; the developer-only `project-path` line moves from `Workspace.tsx` into `ThreeS.tsx`, rendered only when the Editor or Terminal tab is active.

**Tech Stack:** React 18 (Tauri webview), TypeScript, plain CSS (`styles.css`, no CSS modules/framework). No test runner configured for `apps/desktop` — verification is `tsc --noEmit` plus manual click-through via `pnpm desktop`.

## Global Constraints

- No changes to `apps/engine`, `apps/cloud`, or `spikes/theia-shell/` — this plan touches `apps/desktop` only.
- No new npm dependencies.
- No literal chat UI — the existing describe → generate → approve/regenerate-with-feedback loop stays as-is, only relabeled.
- Follow existing naming: BEM-ish flat class names prefixed by component area (`tb-*` for TopBar, bare names for ThreeS/Workspace — e.g. `.project-path`, `.threes-header`), consistent with `apps/desktop/src/styles.css`.
- Typecheck gate: `pnpm --dir apps/desktop exec tsc --noEmit` must pass with zero errors after every task.

---

### Task 1: Planner entry point — TopBar button wired through Workspace to ThreeS

This is one task, not three, because the three files only compile together: `TopBar` needs the new prop type before `Workspace` can pass it, and `ThreeS` needs the new prop before `Workspace` can pass that too. Splitting would leave an intermediate state that fails `tsc --noEmit`.

**Files:**
- Modify: `apps/desktop/src/components/TopBar.tsx`
- Modify: `apps/desktop/src/components/Workspace.tsx`
- Modify: `apps/desktop/src/components/ThreeS.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Produces: `TopBar`'s prop `onOpenPlanner: () => void` (new, required). `ThreeS`'s prop `focusSignal: number` (new, required) — every increment resets `ThreeS`'s internal `tab` state to `"threes"`.
- Consumes: `TopBar`'s existing `activeProject: Project | null` prop (already present) — used to enable/disable the new button. `ThreeS`'s existing internal `tab` state (already present, `useState<"threes" | "graph" | "editor" | "terminal">("threes")`).

- [ ] **Step 1: Add the `onOpenPlanner` prop and button to `TopBar.tsx`**

  In `apps/desktop/src/components/TopBar.tsx`, add `onOpenPlanner` to the destructured props (after `onGateRecheck`):

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
    onOpenPlanner,
  }: {
    tabs: ProjectTab[];
    activeTabKey: string | null;
    activeProject: Project | null;
    onSelectTab: (key: string) => void;
    onCreateProject: (name: string) => Promise<void>;
    reloadSignal: number;
    onWorkspaceContextChange: (ctx: WorkspaceContext) => void;
    onGateRecheck?: () => void;
    onOpenPlanner: () => void;
  }) {
  ```

  Then, in the JSX `return`, insert a new button between the closing `</nav>` of `tb-projects` and the `<div className="tb-account">` block:

  ```tsx
      </nav>

      <button
        type="button"
        className={"tb-planner" + (activeProject ? "" : " tb-planner-muted")}
        disabled={!activeProject}
        title={activeProject ? "Open Planner" : "Select a project first"}
        onClick={onOpenPlanner}
      >
        ✦ Planner
      </button>

      <div className="tb-account">
  ```

- [ ] **Step 2: Add Planner button styles to `styles.css`**

  In `apps/desktop/src/styles.css`, right after the existing `.tb-cloud-link` block (around line 414), add:

  ```css
  .tb-planner {
    white-space: nowrap;
    font-size: 0.9em;
    padding: 5px 14px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .tb-planner:disabled,
  .tb-planner.tb-planner-muted {
    color: var(--muted);
    border-color: var(--border);
    border-style: dashed;
    cursor: not-allowed;
  }
  ```

- [ ] **Step 3: Accept `focusSignal` in `ThreeS.tsx` and reset the tab on change**

  In `apps/desktop/src/components/ThreeS.tsx`, change the component signature:

  ```tsx
  export default function ThreeS({
    project,
    focusSignal,
  }: {
    project: Project;
    focusSignal: number;
  }) {
  ```

  Add a new `useEffect` right after the existing `tab` state declaration (after the line `const [copied, setCopied] = useState<string | null>(null);`):

  ```tsx
    // TopBar's "Planner" button bumps this counter (mirrors the reloadSignal
    // pattern in Workspace.tsx) — every bump jumps back to the Planner tab,
    // even if the user had wandered into Editor/Terminal.
    useEffect(() => {
      setTab("threes");
    }, [focusSignal]);
  ```

- [ ] **Step 4: Wire the counter in `Workspace.tsx`**

  In `apps/desktop/src/components/Workspace.tsx`, add a new state variable next to `refreshTick` (after the line `const [refreshTick, setRefreshTick] = useState(0);`):

  ```tsx
    const [plannerSignal, setPlannerSignal] = useState(0);
  ```

  Pass `onOpenPlanner` to `TopBar` (inside the existing `<TopBar ... />` call, after `onGateRecheck={onGateRecheck}`):

  ```tsx
        onGateRecheck={onGateRecheck}
        onOpenPlanner={() => setPlannerSignal((t) => t + 1)}
  ```

  Pass `focusSignal` to `ThreeS` (change the existing `<ThreeS key={active.id} project={active} />` line):

  ```tsx
            <ThreeS key={active.id} project={active} focusSignal={plannerSignal} />
  ```

- [ ] **Step 5: Typecheck**

  Run: `pnpm --dir apps/desktop exec tsc --noEmit`
  Expected: no errors.

- [ ] **Step 6: Manual verification**

  Run `pnpm desktop`. Confirm:
  - With no project selected, the "✦ Planner" button is visibly disabled (dashed border, muted color) and does nothing on click.
  - With a project active, navigate to the Editor or Terminal tab, then click "✦ Planner" in the top bar — it jumps back to the Planner tab (currently still labeled "3S Workflow" until Task 2).

- [ ] **Step 7: Commit**

  ```bash
  git add apps/desktop/src/components/TopBar.tsx apps/desktop/src/components/Workspace.tsx apps/desktop/src/components/ThreeS.tsx apps/desktop/src/styles.css
  git commit -m "feat(desktop): add Planner button to TopBar (ADR 0016 M1)"
  ```

---

### Task 2: Rename and regroup the per-project tabs

**Files:**
- Modify: `apps/desktop/src/components/ThreeS.tsx`
- Modify: `apps/desktop/src/styles.css`

**Interfaces:**
- Consumes: `ThreeS`'s existing `tab` state and setter (from Task 1, unchanged shape: `"threes" | "graph" | "editor" | "terminal"`).
- Produces: no new interfaces — this is a pure JSX/CSS relabel-and-regroup within `ThreeS.tsx`'s existing render.

- [ ] **Step 1: Relabel and regroup the nav in `ThreeS.tsx`**

  Replace the existing `<nav>` block inside the `<header className="threes-header">` (currently a flat list of four buttons) with two grouped clusters:

  ```tsx
        <nav>
          <div className="nav-group">
            <button
              type="button"
              className={tab === "threes" ? "active" : ""}
              onClick={() => setTab("threes")}
            >
              Planner
            </button>
            <button
              type="button"
              className={tab === "graph" ? "active" : ""}
              onClick={() => setTab("graph")}
            >
              Task Graph
            </button>
          </div>
          <div className="nav-group nav-group-dev">
            <button
              type="button"
              className={tab === "editor" ? "active" : ""}
              onClick={() => setTab("editor")}
            >
              Editor
            </button>
            <button
              type="button"
              className={tab === "terminal" ? "active" : ""}
              onClick={() => setTab("terminal")}
            >
              Terminal
            </button>
          </div>
        </nav>
  ```

  (Only the button label and grouping changed — `threes` stays the internal tab value everywhere else in the file, including the `tab === "threes"` checks lower in the render, to keep this diff minimal.)

- [ ] **Step 2: Add the group divider styles to `styles.css`**

  Replace the existing `.threes-header nav` rule (around line 506) with:

  ```css
  .threes-header nav {
    display: flex;
    gap: 16px;
  }

  .nav-group {
    display: flex;
    gap: 8px;
  }

  .nav-group-dev {
    padding-left: 16px;
    border-left: 1px solid var(--border);
  }
  ```

- [ ] **Step 3: Typecheck**

  Run: `pnpm --dir apps/desktop exec tsc --noEmit`
  Expected: no errors.

- [ ] **Step 4: Manual verification**

  Run `pnpm desktop`. Confirm: the per-project tab row now reads "Planner | Task Graph" as one visual cluster, then a divider, then "Editor | Terminal" as a second cluster. Clicking each still switches panes exactly as before.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop/src/components/ThreeS.tsx apps/desktop/src/styles.css
  git commit -m "feat(desktop): relabel 3S tab as Planner, group business/dev tabs (ADR 0016 M1)"
  ```

---

### Task 3: Move the raw project path into the Developer-tools view

**Files:**
- Modify: `apps/desktop/src/components/Workspace.tsx`
- Modify: `apps/desktop/src/components/ThreeS.tsx`

**Interfaces:**
- Consumes: `ThreeS`'s existing `project: Project` prop (has `.path: string`, already imported via `type Project` from `../api`) and existing `tab` state (from Task 1).
- Produces: no new interfaces — moves an existing stateless JSX block from one component to another.

- [ ] **Step 1: Remove the `project-path` block from `Workspace.tsx`**

  In `apps/desktop/src/components/Workspace.tsx`, delete this block (currently right before the `<CloudConnect ... />` call inside the `active ? (...)` branch):

  ```tsx
            <p
              className="project-path"
              title="Click to copy"
              onClick={() => void navigator.clipboard.writeText(active.path)}
            >
              {active.path}
            </p>
  ```

  The branch should now go straight from `<>` to `<CloudConnect ... />` — `CloudConnect` stays exactly where it is (cloud-sync status remains visible from the Planner view, per the spec).

- [ ] **Step 2: Add the `project-path` block into `ThreeS.tsx`, gated to the Developer-tools tabs**

  In `apps/desktop/src/components/ThreeS.tsx`, insert this right after the closing `</header>` tag and before the "keep terminal + editor mounted" comment:

  ```tsx
      {(tab === "editor" || tab === "terminal") && (
        <p
          className="project-path"
          title="Click to copy"
          onClick={() => void navigator.clipboard.writeText(project.path)}
        >
          {project.path}
        </p>
      )}

  ```

- [ ] **Step 3: Typecheck**

  Run: `pnpm --dir apps/desktop exec tsc --noEmit`
  Expected: no errors.

- [ ] **Step 4: Manual verification**

  Run `pnpm desktop`, open a project. Confirm:
  - On the Planner or Task Graph tab, no filesystem path is shown anywhere.
  - On the Editor or Terminal tab, the click-to-copy path line appears, and clicking it still copies the path (check via pasting somewhere).
  - The cloud-sync status (`CloudConnect`) is still visible regardless of which tab is active.

- [ ] **Step 5: Commit**

  ```bash
  git add apps/desktop/src/components/Workspace.tsx apps/desktop/src/components/ThreeS.tsx
  git commit -m "feat(desktop): move raw project path out of the Planner view (ADR 0016 M1)"
  ```

---

### Task 4: End-to-end verification against the M1 exit criteria

No file changes expected — this task is a checklist confirming the full ADR 0016 M1 exit criteria against the app as it now stands. If verification surfaces a real gap, fix it in the relevant file from Tasks 1–3 and note the fix in the commit message; otherwise this task ends without a commit.

**Files:** none expected.

**Interfaces:** none — this task only exercises the UI built in Tasks 1–3.

- [ ] **Step 1: Full click-through against the ADR exit criteria**

  Run `pnpm desktop`. With a project that has no connected code model and no task graph yet:
  1. Click "✦ Planner" in the top bar from a fresh project — lands on the Planner tab.
  2. Describe a goal, generate the Scope, approve it, generate the Spec, approve it, generate tasks — confirm this whole loop still works exactly as before (Task 1–3 changes were relabeling/regrouping only, not logic changes).
  3. At the Skill stage with no code model connected, confirm the `ConnectForm` (role="code") still renders inline and a connection can be made from there — no separate change needed, this is verifying Task 1–3 didn't regress it.
  4. Switch to Task Graph tab — confirm it renders in the business cluster, to the right of Planner, left of the developer divider.
  5. Switch to Editor and Terminal — confirm the project path line appears only here, and both panes still retain their state (open file, running shell session) when switching back and forth via the Planner button and the tab row.
  6. Confirm `CloudConnect`'s sync-status line is visible on the Planner tab.

- [ ] **Step 2: Final typecheck**

  Run: `pnpm --dir apps/desktop exec tsc --noEmit`
  Expected: no errors.

- [ ] **Step 3: If everything passes, no commit needed for this task.** If any gap was found and fixed, commit that fix with a message describing the specific gap closed.
