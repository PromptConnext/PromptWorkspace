# PromptWorkspace MCP server

Your assigned PromptWorkspace tasks, and the context needed to do them, over the
Model Context Protocol — for the editors the VS Code extension cannot reach.

ADR [0019](../../docs/decisions/0019-desktop-as-vscode-extension.md) made two
decisions about the developer surface. Decision 1 built `apps/vscode`; decision 3
named an MCP server as the portable floor beneath it, because MCP is the one
AI-integration protocol honoured across VS Code, Cursor, Windsurf, Claude Code,
Theia and the JetBrains assistants. A developer working in JetBrains, Neovim or
Zed has no other surface, and once the desktop shells are deleted
([plan 0011](../../docs/plans/0011-desktop-decision-gate.md)) this is the only
thing left for them to install. The build is sequenced in
[plan 0025](../../docs/plans/0025-mcp-server.md).

## What it is, and what it is not

Four tools, through M3. Three read:

- **`list_my_tasks`** — the tasks assigned to you, across every workspace and
  project. Optional `workspace_id` and `status` filters; without `status` the
  cloud answers with open work only (`todo` and `in_progress`).
- **`get_task`** — one task with its acceptance criteria, an excerpt of the
  specification it implements, and the project and repository it belongs to.
- **`get_project_rules`** — the three files the cloud seeded into the project's
  repository (`AGENTS.md`, `docs/conventions.md` and
  `.specify/memory/constitution.md`), read **from your clone**. The project is
  worked out from the folder's git remote: pass `workspace_root` for the clone
  (it defaults to whatever directory your MCP client launched this process in,
  which is often not your project), or `project_id` to name the project outright
  when a repository backs more than one, or when the folder has no remote. A
  missing file is reported as missing rather than quietly skipped, and the
  cloud's constitution stage document is consulted only for provenance — to
  stand in when the file is not in the clone, and to say in one line when the two
  have diverged. The file on disk always wins: the cloud seeds these once and
  never overwrites them.

And one writes:

- **`close_task`** — the status of a task assigned to you, with the commit that
  implemented it. Pass `task_id` and `status`; without `commit_sha` the commit at
  `HEAD` of `workspace_root` is recorded, because a developer closing a task has
  just committed the work. `implemented` is the word for finished work —
  `verified` is a reviewer's, and the cloud refuses it unless you are a workspace
  admin. It changes the status and its artifact and nothing else: not a title,
  not acceptance criteria, not an assignment.

  Three outcomes, and only one of them is a failure. The write lands, or the
  cloud **refuses** it (any 4xx — the task is not yours, or `verified` needs an
  admin) and the tool reports an error, or the cloud is **unreachable** and the
  write is **queued**, which is reported as a normal result because it is: the
  queue is a file beside your session, it survives this process, and it is
  flushed when the server next starts and at the start of the next `close_task`.
  A 4xx never enters that queue — a 403 will not succeed on the tenth attempt
  either — and a second `close_task` for the same task replaces the queued one
  rather than stacking behind it. There is no background timer: an MCP client
  may kill this process at any moment, so the work happens when the process is
  known to be alive.

Streamable HTTP is M4.

This is **not a planning client**. It does not create projects, run stages,
author or edit requirements and specs, upload a PRD, post discussions, or clone a
repository. It never calls `PUT /sync/projects/{id}/graph` — a task client with a
full-graph push can overwrite the requirements and specs the cloud authored, and
`packages/cloud-client/src/client.ts` writes down the same prohibition for the same
reason. There is no task-claim or task-assignment tool either: `/me/tasks`
returns only tasks already assigned to you, so a claim tool would have no caller.

## Install and sign in

The package is not on the npm registry. Each release is a tarball attached to a
GitHub Release (tag `mcp-v<version>`) at
<https://github.com/PromptConnext/PromptWorkspace/releases>. Download
`promptworkspace-mcp-<version>.tgz` and install it globally:

```bash
npm i -g ./promptworkspace-mcp-<version>.tgz
```

That puts a `promptworkspace-mcp` binary on your `PATH`. The release also carries
the bundled `dist/index.js` alone; `node /path/to/index.js` works the same way if
you would rather not install anything.

The server speaks stdio, so your MCP client launches it as a child process. Sign
in once, in a terminal:

```bash
promptworkspace-mcp login
```

That opens `…/login?desktop=1&state=…` in your browser, waits for you to paste
back the code the page shows, and exchanges it for a session it stores locally.
The code is single-use and expires after two minutes; if it does, run `login`
again for a fresh one. Every MCP client on the machine then shares the session.

Then point your client at the server. The shape differs per client, but the
block is always some spelling of (or `"command": "node", "args": ["/path/to/index.js"]`
for the bare bundle):

```json
{
  "mcpServers": {
    "promptworkspace": {
      "command": "promptworkspace-mcp"
    }
  }
}
```

## Configuration

Four settings, named exactly as `apps/vscode/src/config.ts` names them:
`cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey`. An MCP client
launches a bare process with no editor settings to inject, so both a file and
environment variables work, environment winning:

| Setting | Environment variable |
|---|---|
| `cloudApiUrl` | `PROMPTWORKSPACE_CLOUD_API_URL` |
| `cloudWebUrl` | `PROMPTWORKSPACE_CLOUD_WEB_URL` |
| `supabaseUrl` | `PROMPTWORKSPACE_SUPABASE_URL` |
| `supabaseAnonKey` | `PROMPTWORKSPACE_SUPABASE_ANON_KEY` |

The file is `config.json` in the config directory below, and holds those same
four keys. Unset, all four default to production (`https://workspace-api.promptconnext.com`,
`https://workspace.promptconnext.com` and the production Supabase project), from
the one shared list in `packages/cloud-client/src/defaults.ts` that `apps/vscode`
copies. Point a develop/staging run at that stack by overriding all four (e.g.
`PROMPTWORKSPACE_CLOUD_API_URL=https://promptworkspace-api.truthledgers.com`).
Setting `supabaseUrl`/`supabaseAnonKey` to empty puts the client in the cloud's
stub auth mode, which is local development only — a real deployment rejects it.

The config directory is `$XDG_CONFIG_HOME/promptworkspace-mcp` (falling back to
`~/.config/promptworkspace-mcp`), or `%APPDATA%\promptworkspace-mcp` on Windows.
`PROMPTWORKSPACE_MCP_CONFIG_DIR` overrides it.

`projectId`, `closeTasksFromCommits`, `closeTasksOn` and `commitScanLimit` have
no analogue here: there is no folder scope and no git watcher. The extension
closes tasks from commit messages as they are pushed; this server closes one only
when an agent asks it to, so there is nothing to enable or to bound.

Beside `config.json` and `session.json` in that directory sits `queue.json`, the
pending status writes. Deleting it drops writes that have not reached the cloud
yet; nothing else in it matters.

## Where your session is stored, and what that guarantees

Only the Supabase **access and refresh tokens** are treated as secret — nothing a
re-login cannot recover. The session metadata (auth mode, user id, email) sits in
a plain `session.json` beside the config, so a keychain this process cannot reach
degrades into "signed out, sign in again" rather than an unexplained blank.

The storage backend is the one `apps/engine/src/keychain.ts` already uses, plus
the Linux branch that module never had:

- **macOS** — the login keychain, through the `security` CLI. Other applications
  need your approval to read an item they did not create.
- **Windows** — DPAPI, through PowerShell's `ConvertTo-SecureString` /
  `ConvertFrom-SecureString`, written under `%APPDATA%`.
- **Linux** — a `0600` file under the config directory. There is no libsecret
  integration; ADR 0019 names this gap and this is the honest first answer.

**Be clear about what the last two buy you.** On Linux, any process running as
your user can read the refresh token straight off disk. Windows DPAPI encrypts at
rest under your user account but does not isolate you from other applications
running in the same session, which can ask it to decrypt just as we do. On both,
the guarantee is *"not plaintext in your dotfiles"* — not *"isolated from other
local software"*. Only the macOS branch offers the latter. If that matters to
your threat model, treat the machine as the trust boundary and sign out
(`security delete-generic-password`, or delete the config directory) when it
stops being one.

## Development

```bash
pnpm --dir apps/mcp typecheck   # tsc --noEmit
pnpm --dir apps/mcp test        # node --test, no client needed
pnpm --dir apps/mcp build       # esbuild -> dist/index.js
pnpm --dir apps/mcp watch       # esbuild in watch mode
node dist/index.js --help
```

The cloud transport, wire types, session store, error taxonomy, retry queue,
repository-URL matching and seeded-document paths come from `packages/cloud-client`,
shared with `apps/vscode` by `workspace:*`. Fix a transport bug there, not here —
and note that the repo-URL matching in particular is shared precisely so the two
surfaces cannot resolve the same clone to two different projects.

`src/statusWriter.ts` is the one module ported rather than shared: it is
`apps/vscode/src/tasks/statusWriter.ts` minus its editor, since the original
updates a tree view optimistically, rolls that update back, and raises a toast —
none of which exists here. What came across is the branch that matters, the one
that tells a 4xx from everything else.

The one thing deliberately **not** shared is the reader for those seeded files:
`apps/vscode` reads them through `vscode.workspace.fs` and this server over
`node:fs`, because there is no editor here to ask. Likewise the git remotes,
which the extension gets from the built-in Git extension's API and this server
gets by running `git remote -v` in the workspace root — via `execFile`, never a
shell, because that root is caller-supplied input.

Unlike `apps/engine`, this app **is** bundled: it ships to npm and runs through
`npx`, so one file beats a `node_modules` walk on every cold start. The engine's
"no build step" rule is about the engine.

One rule that is easy to break and hard to debug: **in server mode, stdout is the
JSON-RPC channel.** Every diagnostic goes to stderr. A stray `console.log`
corrupts the stream, and the client reports it much later as an unrelated parse
error.
