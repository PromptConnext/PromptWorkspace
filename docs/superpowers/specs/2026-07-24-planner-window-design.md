# ADR 0016 M1 — Planner Window in the current Tauri shell

**Date:** 2026-07-24 · **Scope:** `apps/desktop` only · **Ships regardless of the M0 Theia spike's outcome** (M0 already passed, see `spikes/theia-shell/docs/m0-report.md`, but M1 doesn't depend on it — it's the "value now" track from ADR 0016).

## Context

ADR 0016 ("What moves", M1 milestone) asks for a named **Planner** surface reachable from `TopBar` — the "Agent Window from the top bar" a business user was asking for — plus explicit connect-LLM, generate-tasks-from-requirements, and cloud-sync affordances, and a tidied business/developer split in the existing tabs.

The current desktop app already has nearly all of the underlying functionality:

- `TopBar.tsx` — workspace switcher, project tabs, account status. No entry point for anything below project selection.
- `Workspace.tsx` — renders `CloudConnect` (sync status) and `ThreeS` directly below `TopBar` for the active project. Also renders a raw, click-to-copy `project-path` line, always visible.
- `ThreeS.tsx` — owns a four-way internal tab switcher (`"threes" | "graph" | "editor" | "terminal"`), rendering respectively: the Scope→Spec→Skill stepper (describe → generate → approve/regenerate-with-feedback forms), `GraphView` (task graph), `EditorPane` (Monaco), `TerminalPane` (xterm). `ConnectForm` already surfaces inline at the implement stage when no code model is connected.

So M1 is **not** new functionality — it's promoting and re-labeling what exists, and separating it into a business-facing cluster (Planner, Task Graph) versus a developer-facing cluster (Editor, Terminal), with a TopBar entry point into the former.

## Non-goals

- No turn-by-turn chat UI. The ADR's "chat to plan" is satisfied by the existing describe → generate → approve/regenerate-with-feedback loop, just relabeled. A literal chat thread (streaming, message history) is out of scope for M1 — it would blow past the 2–3 week estimate and isn't what the exit criteria actually require.
- No new backend routes, no engine changes, no schema changes. This is `apps/desktop` React component work only.
- No changes to `apps/engine`, `apps/cloud`, or the Theia spike under `spikes/theia-shell/`.

## Design

### 1. TopBar gets a Planner entry point

Add a "✦ Planner" button to `TopBar.tsx`, placed next to the account section (right side, after the project tabs / cloud-link button, before account status). Behavior:

- Enabled only when a project is active (mirrors the existing `+ New project` disabled-until-workspace-chosen pattern — same `tb-tab-muted` treatment when no project is selected).
- Clicking it tells the per-project view (owned by `ThreeS.tsx`, via a callback threaded through `Workspace.tsx`) to switch to the Planner tab. This is a one-way "jump to Planner" action, not a toggle — if the user is already on Planner, it's a no-op.
- No new routing/state library — `TopBar` already receives callbacks as props (`onSelectTab`, `onCreateProject`, etc.); this follows the same pattern (`onOpenPlanner: () => void`, wired from `Workspace.tsx` down into `ThreeS.tsx`'s existing `tab` state, e.g. by lifting that piece of state up one level or exposing a ref/imperative handle — implementation detail for the plan phase).

### 2. Rename and regroup the per-project tab row

In `ThreeS.tsx`'s tab nav:

- `"3S Workflow"` → `"Planner"` (label only; internal `tab` value can stay `"threes"` to minimize diff, or be renamed to `"planner"` — implementation detail).
- Visually cluster the four tabs into two groups with a divider or subtle group label:
  - **Business:** Planner, Task Graph
  - **Developer tools:** Editor, Terminal
- No change to the underlying tab-switching mechanics (`display: none` toggling to keep Editor/Terminal mounted across switches stays as-is).

### 3. Move dev-facing clutter out of the default Planner view

- The raw `project-path` line (click-to-copy absolute filesystem path) in `Workspace.tsx` currently renders unconditionally above `ThreeS`. Move it so it only renders when the active tab is in the Developer-tools cluster (Editor or Terminal) — a business user planning work never needs to see a filesystem path.
- `CloudConnect` (cloud-sync status) stays visible from the Planner view — the ADR exit criteria explicitly calls for "see cloud-sync status" without touching code machinery. Only the raw path moves; the sync status badge doesn't.

### 4. Connect-LLM affordance — no change needed

`ConnectForm` already surfaces inline within the 3S stepper at the implement stage when no code model is connected (`ThreeS.tsx:341`). Verify it's still reachable and sensible under the new "Planner" label; no new component needed.

## Exit criteria mapping

| ADR 0016 M1 exit criterion | Satisfied by |
|---|---|
| Connect a model, from the top bar | `TopBar` → Planner button → existing `ConnectForm` (inline, contextual) |
| Chat to plan | Existing describe/generate/approve/regenerate-with-feedback loop, relabeled |
| Generate a task graph | Existing Task Graph tab, regrouped into the business cluster |
| See cloud-sync status | Existing `CloudConnect` badge, stays visible in Planner view |
| Without touching code machinery | `project-path`, Editor, Terminal all moved/kept in the Developer-tools cluster, not shown by default in Planner |

## Testing

- Manual: `pnpm desktop`, verify Planner button appears/disables correctly with no project vs. active project; verify tab regrouping renders correctly; verify `project-path` no longer shows when Planner/Task Graph tab is active, does show under Editor/Terminal.
- No new automated test suite exists for `apps/desktop` today (React/Vite, no test runner configured) — this stays consistent with the existing codebase; `tsc --noEmit` typecheck is the available automated gate.
