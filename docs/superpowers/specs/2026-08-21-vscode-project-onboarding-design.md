# VS Code extension — project onboarding: workspace, project, clone

**Date:** 2026-08-21 · **Status:** Approved, not yet implemented · **App:** `apps/vscode` · **Implements:** ADR 0019 ("Pull assigned tasks", "Git integration"), ADR 0020 (cloud is authoritative)

## The problem

The extension shipped as a task client and nothing else. Everything it knows about the cloud arrives through one read, `GET /me/tasks`, and every project it can name is a project that already has a task assigned to the signed-in user. That was a defensible first cut, but it leaves the path from *cloud project* to *local development* unwalkable. A developer added to a workspace whose repository they have never cloned sees an empty sidebar; a project that exists, has a repository, and simply has not had work assigned to this person yet does not exist as far as the extension is concerned. The only way to attach a folder to a project is `Link This Folder to a Project…`, which requires the folder to already be there — the one thing the developer does not have.

The target flow is the obvious one and it is the one this spec builds: sign in, choose a workspace if there is more than one, look at that workspace's projects, and for a project that is not on this machine yet, clone it and start working with its tasks and its coding rules in front of you.

## What does not change

The cloud needs no work. `GET /workspaces` and `GET /workspaces/{workspace_id}/projects` both exist, both are membership-gated through `require_workspace`, and the `Project` model already carries `repo_url`, `repo_default_branch` and `lifecycle_status`. This is entirely an `apps/vscode` change.

There is still no sidecar, no spawned process and no local server. Cloning goes through the built-in Git extension, not a subprocess of ours.

## Decisions taken, and their alternatives

**The open folder is the context; the browser is the on-ramp.** A wizard that owns a persistent "active project" selection would eventually disagree with the folder the developer is editing — you would be reading project A's tasks while typing in project B's repository. Instead the active project is derived from the workspace folders, and the new Projects view exists to get a folder onto the machine in the first place and to hand off to that derivation. Rejected: a wizard as the permanent spine, and a single view that silently flips between browse and task modes.

**Every project in the workspace is listed, with yours sorted first.** Listing only projects that already have your tasks would preserve the current shape and add no cloud reads, but it also preserves the exact hole this spec exists to close. Rejected.

**My Tasks is scoped strictly to the active project.** The consequence is real and accepted: the view stops being a cross-project inbox. The task-count badge on each project row in the Projects view carries that role instead, which is enough to notice work waiting in another repository without the task tree lying about which repository you are in.

**Workspace selection is tree expansion, not a picker.** A picker means a stored selection, which means a selection that can be stale, wrong after a membership change, or out of step with the folder you have open. A collapsible workspace node holds no state at all.

## Architecture

Four new modules, all shaped after modules that already exist in the extension rather than introducing a second set of patterns.

`src/projects/roster.ts` holds the logic and imports nothing from `vscode`. It derives a project's local state, orders projects within a workspace, maps roster entries into the link candidates `ProjectLink` already consumes, and decides whether a pending clone matches a freshly opened folder. The test runner has no editor host, so this separation is what makes any of it testable.

`src/projects/rosterStore.ts` is the cache-first, coalesced, never-rejecting store for workspaces and their projects. It copies `TaskStore`'s contract deliberately, including `lastRefreshError` and `refreshedAt`, because the two stores are rendered by sibling views and an inconsistency between them would show. It writes a new cache file, `roster.json`.

`src/projects/rosterTree.ts` is the `TreeDataProvider` behind the Projects view: workspace nodes over project nodes.

`src/projects/cloneProject.ts` guards a `repo_url` and hands it to the Git extension. It is about twenty lines and it is the only place clone is initiated.

`src/link/activeProject.ts` answers "which project am I in?" once, for both the task tree and the context webview, so the two cannot disagree.

Existing files change as follows. `cloud/client.ts` gains `listWorkspaces()` and `listWorkspaceProjects(workspaceId)`. `cloud/types.ts` gains `Workspace` and `CloudProject`, the latter carrying only the fields actually rendered or acted on — `id`, `name`, `workspace_id`, `repo_url`, `repo_default_branch`, `lifecycle_status`. `link/projectLink.ts` takes its candidates from the roster instead of from task rows, which is what lets it offer a link for a project with no assigned work. `tasks/treeProvider.ts` and `context/contextView.ts` read `activeProject()` where they previously read `workspaceFolders[0]`.

## Local state, derived rather than stored

Every project row renders one of three states, computed at render time:

A project whose `repo_url` is null — still `planning` or `tech_review`, no repository provisioned — is **no-repo**. It renders dimmed and its only action is to open it in the web app.

A project whose `repo_url` matches an open workspace folder's git remote, by the existing `sameRepo` normalisation, is **local**. So is a project whose id appears in a new `knownClones` map in globalState (project id to filesystem path), written whenever a link is established. Its action is to open or reveal that folder.

Anything else with a `repo_url` is **remote-only**, and its action is Clone.

The `knownClones` map exists because without it "is this cloned?" is only answerable for folders open in the current window, and a second window would offer a duplicate Clone for a repository already on disk. It is a cache and is treated as one: an entry pointing at a folder that no longer exists degrades silently to remote-only.

A `repo_url` that fails `assertCloneableRepoUrl` renders as no-repo and is logged. The guard runs at the roster boundary, before the URL is rendered, compared or handed to git — the same rule `projectLink.ts` already applies to task rows, now covering the browse path too.

## The views

**Projects** (`promptconnext.projects`) renders workspace nodes sorted by name, each holding its projects. Within a workspace, projects with tasks assigned to the signed-in user come first ordered by count, then local projects with no assigned work, then the rest, then no-repo projects last, with name breaking ties. A workspace auto-expands when it contains any project with your tasks, and always when it is the only workspace — which is how "select a workspace" happens without a selection existing.

Each project row shows an icon for its local state, and a description combining the assigned-task count with that state: `3 tasks · cloned`, `1 task · not cloned`, `planning · no repo yet`. The inline action follows the state: Clone, Open, or Open in web app. The context menu adds Open in web app everywhere and a link-an-open-folder command.

Its welcome content is the extension's entry point now, so the sign-in links appear here too. Both views show them when signed out — the Projects view is first in the container and is where a new user lands, but My Tasks keeps its existing signed-out welcome rather than going blank when a user has it focused. Signed in with no workspaces, the Projects view says so and offers the web app.

**My Tasks** keeps its tree, its checkboxes and its status writes, and gains a scope. Its view description names the active project, so the scope is never a guess. Switching projects means opening a file in the other folder; the extension contributes no switcher of its own because VS Code already has one. Its welcome content gains a third case: signed in with no linked folder, it points at the Projects view.

**Project Context** is unchanged in behavior, with one bug fixed on the way past. It currently hardcodes `workspaceFolders[0]` for both rendering and its Open-in-editor message handler, so in a multi-root window it shows the wrong repository's rules and opens the wrong file. It moves to the active project's folder.

## The clone handoff

`git.clone` clones into a folder and then opens it, usually in a new window — a different extension host from the one that started the clone. The link has to survive that jump, and the mechanism is a small piece of globalState, which unlike workspaceState is shared across windows.

Before invoking the command, the extension writes `pendingClone` as `{projectId, repoUrl, startedAt}`. It then calls `git.clone` with the guarded URL and stops; VS Code owns the folder picker, the progress notification and any credential prompts. When the new window activates, the roster is read from `roster.json` in global storage, so this step works with no network at all. A workspace folder whose remote `sameRepo`s the pending clone's URL has `promptconnext.projectId` written **without a prompt** — the user answered that question when they clicked Clone — after which `pendingClone` is cleared, `knownClones` records the path, and a confirmation message names the project.

Any other unlinked folder that happens to match a roster project still goes through today's confirm-first prompt. A `pendingClone` older than an hour is ignored and discarded, so an abandoned clone cannot silently link a folder days later. A clone that lands with a remote the normalisation does not match — a fork, an SSH config alias — falls through to that same confirm-first prompt, which is the correct degradation.

`git.clone` is a contributed command, not published API; it sits in the same stability class as the vendored `git.d.ts`. It is feature-detected by `commands.getCommands(true)` and its absence falls back to copying the URL to the clipboard with a message naming it. That is invoke-and-inspect, not `typeof`, which is what ADR 0019 requires and what the `pretest` grep enforces.

## Cache, sign-out and refresh

`roster.json` joins `CACHE_FILES`, which matters most at sign-out: today's handler clears tasks and the write queue only, and a roster left behind would show one account's workspace and project names to the next person to sign in on that machine. Sign-out must clear the roster and `knownClones` along with everything else.

Refresh triggers mirror `TaskStore` exactly — activation, sign-in, the explicit Refresh command, and window focus sharing the existing sixty-second throttle. A roster refresh is one request for the workspace list plus one per workspace for its projects, issued concurrently.

## Failure

Nothing here throws at the user. A roster fetch that fails leaves the cached roster rendered with an offline marker in the view description, and only the explicit Refresh command reports it, once, with a Show Log affordance — the same asymmetry `TaskStore` already implements, for the same reason: a background refresh must not nag. A 403 on one workspace, which is what a revoked membership looks like mid-session, drops that workspace from the tree and logs it. A `repo_url` failing the guard becomes a no-repo row. A missing `git.clone` becomes a clipboard copy. A cancelled or failed clone writes nothing, and its `pendingClone` expires.

## Testing

The unit runner has no editor host, so `src/projects/roster.ts` carries the logic and the tests, and the vscode-facing wrappers carry neither. `test/unit/roster.test.ts` covers: a null `repo_url` yields no-repo and is never offered for clone; a `repo_url` failing the guard degrades to no-repo and is never cloneable; an open folder's SSH remote matches an https `repo_url`; a `knownClones` entry pointing at a vanished folder degrades to remote-only; the mine-first sort orders by task count, then local, then name; a matching `pendingClone` links silently; a `pendingClone` older than an hour does not; and a remote matching no pending clone falls through to the confirm-first path.

The queue's existing "clear drops everything" test extends to cover `roster.json` and `knownClones`, because sign-out leaking either is a privacy defect rather than a cosmetic one.

## Out of scope

No cloud changes; both reads already exist. No branch or checkout UI — `repo_default_branch` is read but clone takes git's default, and switching branches is the Git extension's job. No project creation from the extension, since planning lives in `apps/web`. No cross-project task inbox, which is the accepted cost of scoping My Tasks. No change to the MCP server, which ADR 0019 treats as a separate artifact.

`README.md` and `CHANGELOG.md` document the new flow. No ADR is needed: this implements workflows ADR 0019 already specifies rather than deciding against them.
