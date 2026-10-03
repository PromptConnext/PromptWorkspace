# PromptWorkspace for VS Code

Your assigned PromptWorkspace tasks, the project's AI coding rules, and a way to close a task
without leaving the editor.

The cloud plans; you implement. This extension pulls the tasks assigned to you, shows the
coding rules the project was seeded with, hands a task to whichever AI assistant you already
run, and marks the task implemented when you commit.

## What it does

**Projects view** — every workspace and project you belong to, with each project's local state:
`cloned`, `not cloned`, or `no repo yet`. Click **Clone Repository** on a project you have not
cloned and VS Code's own Git extension takes it from there — folder picker, progress, and the
"open the result?" prompt are all VS Code's, not ours. Say **Open** and the new window links
itself to that project automatically, with no confirmation prompt: you already answered that
question when you clicked Clone. A project already cloned offers **Open Project Folder** instead.
This is also where work waiting in a repository you don't currently have open shows up — as a
task count on that project's row — since My Tasks itself only shows one project at a time.

**My Tasks** — the tasks assigned to you **in the project of the folder you currently have
open**, not every assigned task across every workspace. Switch folders (or windows) and the list
follows. Tick the checkbox to mark one implemented, or use *PromptWorkspace: Set Task Status…* for
the full set of states.

**Project Context** — `AGENTS.md`, `docs/conventions.md` and `.specify/memory/constitution.md`,
read from your clone. These are the same files your coding agent reads, and they are yours to
edit — the cloud seeds them once and never overwrites them. If the cloud's constitution has
moved on since seeding, the view says so.

**Copy Task Context** — assembles the task, its acceptance criteria, the relevant spec excerpt
and the project's coding rules into your clipboard, ready to paste into any assistant. Works
offline, works in every editor, works when nothing else does.

**Close a task from a commit** — commit `T3: add retry` and the task closes in the cloud with
the commit attached as evidence. `T003` and `T3` mean the same task. A `Revert "…"` does not
re-close anything. Turn it off with `promptworkspace.closeTasksFromCommits`.

## Setup

1. **PromptWorkspace: Sign In** — signs you in through your browser. If the redirect never comes
   back (common on Linux, where the URL scheme is often unregistered), choose *Paste code
   instead*.
2. Open the **Projects** view. It lists every workspace you belong to; expand one to see its
   projects.
3. **Clone** a project you don't have on this machine yet, or **Open Project Folder** for one you
   do. Cloning hands off to VS Code's own Git extension, and the folder it produces links itself
   to that project the moment its window activates — no prompt, because clicking Clone already
   answered the question.
4. From here, **My Tasks** and **Project Context** follow whichever folder's window you're in.
   Opening a folder some other way (not through Clone or Open Project Folder) still works: the
   extension offers to link it the first time it sees a git remote matching one of your projects,
   and writes `promptworkspace.projectId` into `.vscode/settings.json`. A project id is not a
   secret — commit it so your team shares it.

Work assigned to you in a project you have not opened does not vanish — it shows up as a task
count on that project's row in the Projects view, since My Tasks only ever shows the one project
your current folder belongs to.

### Settings

| Setting | What it is |
|---|---|
| `promptworkspace.cloudApiUrl` | The cloud API. Defaults to production (`https://workspace-api.promptconnext.com`); point at `https://promptworkspace-api.truthledgers.com` for staging or `http://localhost:8080` for local development. |
| `promptworkspace.cloudWebUrl` | The web app that hosts the sign-in pages. Defaults to `https://workspace.promptconnext.com`. |
| `promptworkspace.supabaseUrl` / `supabaseAnonKey` | Real authentication; default to the production project. Override both together with the other two to reach staging. Set both empty and the extension talks to a cloud running in stub auth mode. |
| `promptworkspace.projectId` | Which cloud project a folder belongs to. Set by *Link This Folder to a Project…*. |
| `promptworkspace.closeTasksFromCommits` | Close tasks from commit subjects. Default on. |
| `promptworkspace.commitScanLimit` | How far back to read on a repository's first scan. Default 1000. |

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

### Testing against a local cloud

No Supabase, no browser handoff — with `supabaseUrl` empty the cloud runs in stub auth mode and
signing in is just a user id.

```bash
cd apps/cloud
DATA_BACKEND=memory AUTH_MODE=stub .venv/bin/uvicorn app.main:app --port 8081

node apps/vscode/scripts/seed-local.mjs    # workspace + project + 3 assigned tasks
```

The script prints the settings to paste into the Extension Development Host's `settings.json`.
Then: **PromptWorkspace: Sign In** → enter `dev-user` → the tree fills.

Port **8081**, not the cloud's usual 8080: that port is commonly taken already, and the symptom
is not a bind failure but a 404 from someone else's server, which reads like a routing bug in
ours. Check with `lsof -iTCP:8081 -sTCP:LISTEN -n -P` and use `PROMPTWORKSPACE_API` plus `--port` to move
both halves together if it is busy too.

Host `127.0.0.1`, not `localhost`: uvicorn binds IPv4 only, macOS resolves `localhost` to `::1`
first, and an unrelated IPv6 listener answers instead.

To exercise the commit-close path, link a folder with **PromptWorkspace: Link This Folder to a
Project…**, then `git commit --allow-empty -m "T1: add login retry"`. Within a couple of seconds
the task flips to implemented with the commit attached. `T01`, `T001` and `T0001` all mean the
same task; `T012` is seeded so you can check `T12` finds it too; and
`git commit --allow-empty -m 'Revert "T1: add login retry"'` must *not* re-close anything.

Two things you cannot test this way, both worth knowing before you conclude something is broken:

- **Automatic link discovery.** It matches a folder's git remote against the project's
  `repo_url`, and nothing sets `repo_url` outside real GitHub repo creation at tech-review exit.
  Locally, link manually — the same code path writes the same setting.
- **The browser sign-in handoff.** Stub mode skips it. To exercise it you need Supabase
  credentials and `pnpm web` running, with `promptworkspace.cloudWebUrl` pointed at it.

The memory backend keeps everything in process, so restarting uvicorn wipes the data and you
re-run the seed. That is a feature — starting over costs nothing.

There is no sidecar, no bundled runtime and no local server — see ADR 0019. If a change appears
to need one, that is the point to stop and raise it.
