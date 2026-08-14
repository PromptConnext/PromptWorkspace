# PromptConnext for VS Code

Your assigned PromptConnext tasks, the project's AI coding rules, and a way to close a task
without leaving the editor.

The cloud plans; you implement. This extension pulls the tasks assigned to you, shows the
coding rules the project was seeded with, hands a task to whichever AI assistant you already
run, and marks the task implemented when you commit.

## What it does

**My Tasks** — every task assigned to you, across every workspace you belong to, grouped by
project. Tick the checkbox to mark one implemented, or use *PromptConnext: Set Task Status…*
for the full set of states.

**Project Context** — `AGENTS.md`, `docs/conventions.md` and `.specify/memory/constitution.md`,
read from your clone. These are the same files your coding agent reads, and they are yours to
edit — the cloud seeds them once and never overwrites them. If the cloud's constitution has
moved on since seeding, the view says so.

**Copy Task Context** — assembles the task, its acceptance criteria, the relevant spec excerpt
and the project's coding rules into your clipboard, ready to paste into any assistant. Works
offline, works in every editor, works when nothing else does.

**Close a task from a commit** — commit `T3: add retry` and the task closes in the cloud with
the commit attached as evidence. `T003` and `T3` mean the same task. A `Revert "…"` does not
re-close anything. Turn it off with `promptconnext.closeTasksFromCommits`.

## Setup

1. **PromptConnext: Sign In** — signs you in through your browser. If the redirect never comes
   back (common on Linux, where the URL scheme is often unregistered), choose *Paste code
   instead*.
2. Open a clone of a project's repository. The extension offers to link the folder when a git
   remote matches one of your projects, and writes `promptconnext.projectId` into
   `.vscode/settings.json`. A project id is not a secret — commit it so your team shares it.

### Settings

| Setting | What it is |
|---|---|
| `promptconnext.cloudApiUrl` | The cloud API. Point at `http://localhost:8080` for local development. |
| `promptconnext.cloudWebUrl` | The web app that hosts the sign-in pages. |
| `promptconnext.supabaseUrl` / `supabaseAnonKey` | Real authentication. Leave empty and the extension talks to a cloud running in stub auth mode. |
| `promptconnext.projectId` | Which cloud project a folder belongs to. Set by *Link This Folder to a Project…*. |
| `promptconnext.closeTasksFromCommits` | Close tasks from commit subjects. Default on. |
| `promptconnext.commitScanLimit` | How far back to read on a repository's first scan. Default 1000. |

## Offline

Your task list is cached and renders instantly, including with no network. Status changes you
make offline are queued and flush when you reconnect — the status bar shows how many are
waiting. Signing out discards the queue, and warns you first.

On Linux with no available keyring, VS Code stores secrets in memory and they are lost when the
window reloads. That costs you an occasional re-login; nothing else is affected.

## Known gap

If a Tech Lead hand-edits the tasks document in the web app rather than regenerating it, the
cloud creates no task rows, and this extension will show nothing for that project. That is a
cloud-side gap (ADR 0020), not an extension bug.

## Development

```bash
pnpm --dir apps/vscode watch      # esbuild, incremental
pnpm --dir apps/vscode typecheck
pnpm --dir apps/vscode test       # node --test, no editor host required
pnpm --dir apps/vscode package    # produces a .vsix
```

Then press **F5** to launch an Extension Development Host.

There is no sidecar, no bundled runtime and no local server — see ADR 0019. If a change appears
to need one, that is the point to stop and raise it.
