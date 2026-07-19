# Desktop: open the current project's cloud page from the top bar

Status: Approved 2026-07-19

## Goal

The desktop top bar has no way to jump to the currently-open project's page on the cloud web app. Add a small "open in cloud" control next to the project tabs, visible only when the open project is linked to a cloud workspace.

## Engine change (`apps/engine`)

`routes/cloud.ts`'s `GET /engine/cloud/config` handler (currently `c.json({ enabled: Boolean(CLOUD_API_URL), mode: cloudMode() })`) adds `webUrl: CLOUD_WEB_URL` — the same `CLOUD_WEB_URL` constant (`config.ts:31-32`) already used to build the browser-login URL. No new route; `CLOUD_WEB_URL` always has a value (env override or the shipped default), so `webUrl` is unconditional.

## Desktop changes (`apps/desktop`)

- `api.ts`: `CloudConfig` type gains `webUrl: string`.
- `Workspace.tsx`: passes its existing `active: Project | null` state to `<TopBar activeProject={active} .../>` — a new prop; `TopBar` currently only receives tab key/name, never project data.
- `TopBar.tsx`: new required prop `activeProject: Project | null`. Computes
  `cloudLink = activeProject?.cloud_workspace_id && activeProject?.cloud_project_id && config?.webUrl ? \`${config.webUrl}/w/${activeProject.cloud_workspace_id}/p/${activeProject.cloud_project_id}\` : null`.
  Renders one icon-button directly after the `tabs.map(...)` block (before the "+ New project" affordance) when `cloudLink` is non-null — a single element, not per-tab, since only one tab is ever active. Click calls the already-imported `openUrl(cloudLink)` (from `@tauri-apps/plugin-opener`), wrapped in try/catch that sets the existing `acctError` state on failure, mirroring `beginBrowserLogin`'s error handling.
- `styles.css`: small style for the new button, reusing existing button/icon conventions — no new visual language.

## Error handling

No network call is needed to build the link (pure string join from already-loaded `config`/`activeProject` fields). `openUrl` failures surface through the existing `acctError` state/rendering, same path as the current sign-in button.

## Testing

No component test harness exists for the desktop app. Manual verification: open a cloud-linked project → the icon appears next to its tab → clicking opens `{webUrl}/w/{workspaceId}/p/{projectId}` in the system browser and lands on that project. Open a local-only/unlinked project → the icon is absent. Switch between a linked and unlinked project → icon appears/disappears correctly with no stale link.

## Out of scope (YAGNI)

No workspace-level (non-project) cloud link. No deep-linking to a specific tab (Graph/Tasks/Progress/Discussion) within the project page — always the project's default landing page. No handling for a `cloud_project_id` that the cloud side has since deleted (out-of-scope 404 is the web app's concern, same as any other stale link).
