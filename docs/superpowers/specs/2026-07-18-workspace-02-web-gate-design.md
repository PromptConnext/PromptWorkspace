# Workspace experience — Sub-project 2: Web workspace gate + context

Status: Approved 2026-07-18 · Part 2 of 4 · Depends on Part 1 (cloud foundation)

## Goal

Give `apps/web` a first-class active-workspace context: a provider that holds and
persists the selected workspace, a gate that resolves it on entering the authed
app (auto-enter on a single membership, picker on many, remember last), and
project loads scoped through the new `GET /workspaces/{id}/projects` endpoint.

## Current state (what changes)

Today the active workspace is URL-param-only (`w/[workspaceId]/page.tsx:49`);
there is no context or persistence. The picker at `/` links to `/w/{id}`
(`app/page.tsx`). The per-workspace page fetches ALL projects and filters
client-side (`w/[workspaceId]/page.tsx:13`). Auth context lives in
`lib/auth.tsx`.

## Components

### `WorkspaceProvider` (`lib/workspace.tsx`, new)
React context mirroring `auth.tsx`'s shape. Holds:
- `memberships: Workspace[]` — from `GET /workspaces` (the caller's memberships).
- `activeWorkspace: Workspace | null` — the current scope.
- `loading: boolean`.
- `setActiveWorkspace(id)` — sets active + persists id to `localStorage`
  (`pz_active_workspace`).
- `clearActiveWorkspace()`.

On mount (and when auth user changes): fetch memberships; resolve active from
localStorage if that id is still a current membership, else leave null. Mounted
inside `AuthProvider`, below it in the tree (needs the user). Reset on sign-out.

### `WorkspaceGate` (`components/WorkspaceGate.tsx`, new)
Wraps authenticated content. Logic once memberships loaded:
- 0 memberships → render an empty state ("You're not in any workspace yet — ask
  an admin to invite you"). No auto-create on web (creation stays desktop-side
  per current copy; revisit later).
- exactly 1 → auto-select it (call `setActiveWorkspace`) and render children.
- >1 and none active → render the picker (the existing `/` list UI, extracted).
- active set → render children.

### Routing reconciliation
`/w/[workspaceId]/*` remains the addressable form. On entering such a route, if
its `workspaceId` is a valid membership, treat it as an explicit selection: set
it active (so deep links and switching stay consistent). If not a membership →
redirect to `/` (the gate). `/` hosts the gate/picker.

### Workspace switcher (top nav)
A small dropdown in the shared header/topbar showing `activeWorkspace.name` and
the other memberships; selecting one calls `setActiveWorkspace` and navigates to
that workspace's home. Reuses `memberships` from context — no extra fetch.

## Data flow

- Memberships: `GET /workspaces` (existing) via `useCloudGet`.
- Projects: switch the per-workspace page from `GET /projects` + filter to
  `GET /workspaces/{activeWorkspace.id}/projects` (Part 1). Removes the
  client-side filter at `w/[workspaceId]/page.tsx:13`.
- Persistence: `localStorage["pz_active_workspace"]` = workspace id. Validated
  against memberships on load (stale id ignored).

## Error handling
- Memberships fetch fails → gate shows a retry/error state, not a blank screen.
- Persisted id no longer a membership (removed/left) → silently cleared, fall to
  gate resolution.
- Auth mode: unchanged; the gate sits inside `RequireAuth`.

## Testing
Web has no unit harness today; verification is `tsc --noEmit` + `next build`
clean with all routes present, plus a manual walk-through: single-membership user
auto-enters; multi-membership user sees the picker; selection persists across a
reload; switcher changes scope; a stale persisted id falls back to the picker.
If a lightweight test setup is trivial to add for the provider's
resolve-from-localStorage logic, add it; otherwise document the manual steps.

## Out of scope (YAGNI)
Workspace creation UI on web (stays desktop; separate decision), per-workspace
theming, cross-tab active-workspace sync, breadcrumb redesign.
