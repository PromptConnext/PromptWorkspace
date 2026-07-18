# Workspace experience — Sub-project 4: Desktop active-workspace + gate

Status: Approved 2026-07-18 · Part 4 of 4 · Depends on Part 1 (cloud foundation)

## Goal

Bring the active-workspace concept to the desktop app, which today has none:
local projects have no `workspace_id` (`db.ts:7`) and workspace is only an
optional per-project cloud link (`integrations` kind `cloud`). Add a persisted
active workspace in the engine, a post-login gate/picker in the desktop UI, and
scope the local project list to the active workspace **by cloud-link**, with an
"unassigned" bucket for unlinked local projects.

## Model decision (locked)

Local-first stays intact. The active workspace does **not** add a `workspace_id`
column to `projects`. Instead it filters the visible local projects to those
whose `integrations` cloud-link points at the active workspace; locally-created
projects with no cloud link appear in a separate **Local / unassigned** group.
Creating/linking a project defaults its workspace to the active one.

## Engine changes (`apps/engine`)

### Active-workspace state
Store in `app_state` (the existing key/value store, `db.ts:96`) under
`active_workspace` — a JSON `{ id, name }` (name cached for display). Survives
restarts and is independent of the `CloudSession` (`cloudClient.ts:11`), so it
persists across re-auth. Cleared on `clearCloudSession`/logout.

### Routes (`routes/cloud.ts`)
- `GET /engine/cloud/active-workspace` → `{ id, name } | null`.
- `PUT /engine/cloud/active-workspace` body `{ id }` → validates the id against
  the caller's cloud memberships (`cloudFetch("/workspaces")`), stores
  `{id, name}`, returns it. 400 if not a member.
- `DELETE /engine/cloud/active-workspace` → clears it.
- `GET /engine/cloud/workspaces/:id/projects` → proxy to the Part 1
  `GET /workspaces/{id}/projects` (cloud projects in that workspace), used to
  reconcile/link. (Local project listing stays the existing local route; this is
  for showing cloud-side projects when linking.)

`clearCloudSession` (logout) also clears `active_workspace`.

### Local project scoping
The engine gains a way to group local projects by their cloud-link workspace.
Either extend the local projects listing to include each project's linked
`workspace_id` (join `integrations` kind `cloud`), or add
`GET /engine/projects?workspace=<id>`. Prefer annotating the existing local
projects response with `cloud_workspace_id: string | null` so the desktop can
group client-side without a second round trip. New `cloud-link` writes
(`cloud.ts:144`) default `workspaceId` to the active workspace when the caller
omits it.

## Desktop changes (`apps/desktop`)

### Workspace gate (after cloud login)
Once `getCloudSession()` reports connected (supabase or stub), resolve the active
workspace: read `GET /engine/cloud/active-workspace`; if set and still a
membership, use it. Else fetch `listCloudWorkspaces()`: 0 → prompt to create one
(reuse the existing create-workspace path from `CloudConnect`); 1 → auto-select
via `PUT`; >1 → show a picker. Remember-last means the gate is skipped on
subsequent launches once chosen.

### Workspace switcher + scoped project list
- A workspace indicator/switcher in the desktop shell (`Workspace.tsx` /
  `TopBar`), showing the active workspace, letting the user switch (calls `PUT`,
  re-scopes the list).
- The project list (`Workspace.tsx:35`) groups by the annotated
  `cloud_workspace_id`: projects linked to the active workspace shown first;
  unlinked local projects under a **Local / unassigned** header; projects linked
  to *other* workspaces are hidden while that workspace isn't active.
- `CloudConnect`'s per-project workspace `<select>` (`CloudConnect.tsx:175`)
  becomes optional: linking defaults to the active workspace; the select remains
  as an override for moving a project to a different workspace.

## Data flow
- Active workspace: desktop ↔ engine via the new routes; engine persists in
  `app_state`.
- Membership validation on `PUT` uses `cloudFetch("/workspaces")` (the caller's
  memberships), so an invalid/non-member id is rejected server-side in the
  engine.
- Project grouping: annotated local projects list (`cloud_workspace_id`) drives
  client-side grouping — no per-project fetch.

## Error handling
- `PUT` with a non-member id → 400; desktop surfaces "not a member of that
  workspace".
- Cloud unreachable during gate resolution → fall back to the last stored
  `active_workspace` (offline-friendly, local-first); if none, show the picker
  disabled with a "connect to cloud" note. Local project work must not be blocked
  by cloud being down — unassigned local projects always remain usable.
- Logout clears active workspace; next login re-gates.

## Testing
Engine has no test suite; verify `tsc --noEmit` (engine + desktop) and
`cargo build` if any Rust touched (likely none). Manual: single-workspace user
auto-enters; multi-workspace user picks; choice persists across app restart;
switching re-scopes the project list; unlinked local projects appear under
"Local / unassigned" and stay usable with cloud offline; new project links to the
active workspace by default.

## Out of scope (YAGNI)
Moving/bulk-reassigning many projects between workspaces at once, per-workspace
agent/model presets (settings scoping is a later pass — this sub-project only
scopes the project list + link default), workspace-scoped local encryption.
