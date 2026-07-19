# Desktop: surface local project path + pick folder on first cloud open

Status: Approved 2026-07-19

## Goal

`projects.path` (`db.ts:6-12`, `TEXT NOT NULL UNIQUE`) already exists for every
local project, but the desktop UI never shows it — users run `pwd` in a
terminal to find where a project lives. Worse, when a cloud-only project (never
opened on this machine) is first opened, `createLocalProjectShell` silently
picks `~/PromptConnext-Projects/<slug>` (`routes/projects.ts:74-95`) with no
user input. This adds (1) a visible path once a project has a local directory,
and (2) a folder-picker step — skippable to the same default — the first time
a cloud project is opened locally.

## Constraint

The picker must run desktop-side: the engine is a headless Node sidecar with
no GUI capability. No native folder-picker plugin exists in this repo today
(`apps/desktop/package.json`, `src-tauri/Cargo.toml` have no `dialog` entry) —
this adds `@tauri-apps/plugin-dialog` + the matching Rust `tauri-plugin-dialog`
crate, following the same official-plugin pattern already used for
updater/opener/process.

## Engine changes (`apps/engine`)

### `routes/cloud.ts` — `POST /engine/cloud/projects/:cloudProjectId/open`
Currently calls `createLocalProjectShell(rosterProject.name)` with no path
(`cloud.ts:190-208`). Reads an optional `path` from the JSON body and forwards
it: `createLocalProjectShell(rosterProject.name, path)` — the function already
accepts this param, no engine-side plumbing beyond the route needed.

Path collision (the `path` column is `UNIQUE`) currently bubbles up as a raw
SQLITE constraint error → 500. Catch it in the route and return `409` with a
message like "That folder is already used by another project." so the desktop
can show something the user can act on.

No DB schema change — `path` is already populated and required for every row.

## Desktop changes (`apps/desktop`)

### `api.ts`
- `openCloudProject(cloudProjectId, path?)` — send `path` in the request body
  when provided.
- `Project` type is unchanged (`path: string` already there).

### `Workspace.tsx` — first-open gating
`selectTab` currently calls `openCloudProject(cloudId)` unconditionally for
every `cloud:` tab click (`Workspace.tsx:100-122`). Split on whether a local
project already carries this `cloud_project_id` (i.e. already opened before):
- **Already opened** — unchanged behavior (idempotent open, instant).
- **First open** — don't call the open route yet. Set
  `pendingCloudOpen = { key, cloudId, name }`; the tab still highlights
  (`activeTabKey`), but the content pane renders a small picker panel instead
  of `CloudConnect`/`ThreeS`:
  - **"Choose folder…"** → `@tauri-apps/plugin-dialog`'s
    `open({ directory: true, multiple: false, title: <project name> })`; on a
    path, finish the open with it. Cancel → stay on the panel, no-op.
  - **"Use default location"** → finish the open with no `path` (engine falls
    back to `~/PromptConnext-Projects/<slug>` as it does today). This is the
    skip path — no forced picker.
  - Both call the existing `openError`-surfacing logic on failure
    (`Workspace.tsx:119-121` today), so a 409/mkdir failure shows above the
    panel and the panel stays for a retry with a different folder.

### Path display
Once `active` is set, render a small muted row showing `active.path`
(click-to-copy) directly above `CloudConnect` in the content pane
(`Workspace.tsx:174-181`). No new type/route needed — `path` is already on
every `Project`.

### New dependency wiring
- `apps/desktop/package.json`: add `@tauri-apps/plugin-dialog`.
- `apps/desktop/src-tauri/Cargo.toml`: add `tauri-plugin-dialog`.
- `apps/desktop/src-tauri/src/lib.rs`: `.plugin(tauri_plugin_dialog::init())`
  alongside the other plugin registrations.
- Tauri capabilities config: grant the dialog `open` permission to the main
  window (same pattern as existing plugin capability grants).

## Data flow

Desktop picks (or skips) a folder → sends `path` (or omits it) to the existing
open route → engine creates the local shell there (or at the default) → same
`hydrateProjectGraph` pull as today, unchanged. Path never flows through the
cloud — purely a local desktop↔engine concern, consistent with credentials/code
never syncing.

## Error handling

- Dialog cancelled → no-op, stay on the picker panel.
- `mkdir` failure (unwritable folder) or path collision (`409`) → surfaced via
  the existing `openError` state above the panel; panel stays so the user can
  retry with a different folder or fall back to "Use default location".
- Already-opened projects never see the panel — no behavior change, no new
  failure mode for the common case.

## Testing

Engine: extend `apps/engine/test/g2-roster.test.ts` (or a new file) —
open-route honors a custom `path`; a colliding `path` returns `409` not `500`.

Desktop has no component test harness today — manual verification via
`pnpm desktop`: first open of a fresh cloud project shows the picker; "Choose
folder…" creates the project there; "Use default location" matches today's
behavior; an already-opened cloud project skips straight through as before;
the path row renders and updates when switching between open projects.

## Out of scope (YAGNI)

Brand-new (non-cloud) project creation (`Workspace.tsx`'s `create()`) keeps its
current silent-default path — this spec only covers the cloud-first-open case
the user actually asked about. No "relocate folder for an already-open
project" feature. No pre-`mkdir` writability probe beyond what `mkdirSync`
already surfaces as an error.
