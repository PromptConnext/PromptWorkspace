# Plan 0025 — The MCP server

**Date:** 2026-09-12 · **Status:** Ready for implementation, gated on plan [0011](./0011-desktop-decision-gate.md) · **ADR:** [0019](../decisions/0019-desktop-as-vscode-extension.md)

ADR 0019 made two decisions about the developer surface. Decision 1 built a VS Code extension; decision 3 named an MCP server as the portable floor beneath it, because MCP is the one AI-integration protocol honoured across VS Code, Cursor, Windsurf, Claude Code, Theia and the JetBrains assistants. Decision 5 then made the server load-bearing rather than decorative: our job is "supplying context and receiving outcomes," through `lm.registerTool` on VS Code "and through the MCP server everywhere."

Half of that shipped. `apps/vscode/src` is 4,825 lines across 31 modules and does the whole job inside one editor family. The server does not exist — the only occurrences of "MCP" under `apps/` are a marketing string and the integration-kind enum at `apps/engine/src/db.ts:83`. A developer in JetBrains, Neovim or Zed has no surface at all today, and [§4.2 of the product vision](../product-vision-2026-09-12.md) lists closing that gap as one of four bets worth funding. This plan builds the smaller half.

---

## 1. What it is, and what it is not

One small server over the same cloud API, speaking MCP, with four tools and no user interface of its own.

- **`list_my_tasks`** — the caller's assigned tasks across every project, from `GET /me/tasks` (`apps/cloud/app/api/me.py:26`). Optional `workspace_id` and `status` filters; the endpoint defaults to the two open states (`apps/cloud/app/api/me.py:23`).
- **`get_task`** — one task with its acceptance criteria, the relevant spec excerpt, and the project and repository it belongs to. This is the payload `apps/vscode/src/tasks/copyContext.ts:17` already assembles for the clipboard, returned as text instead of copied.
- **`get_project_rules`** — the three seeded files (`AGENTS.md`, the conventions doc and the constitution) read **from the clone**, at exactly the paths `apps/vscode/src/context/repoDocs.ts:16` enumerates, with the cloud's `stage-documents/constitution` as a provenance fallback only.
- **`close_task`** — a status write through `PATCH /projects/{id}/tasks/{tid}/status` (`apps/cloud/app/api/sync.py:565`), optionally carrying a commit artifact.

Everything else is out of scope. **This is not a planning client**: it does not create projects, run stages, author or edit requirements and specs, upload a PRD, post discussions, or clone a repository. Above all it never touches `PUT /sync/projects/{id}/graph` — the same prohibition `apps/vscode/src/cloud/client.ts:246-250` writes down, for the same reason: a task client with a full-graph push can overwrite the requirements and specs the cloud authored. Nor does it write assignment: `/me/tasks` returns only tasks already assigned to the caller, which is exactly what the status endpoint's member branch requires (`apps/cloud/app/api/sync.py:595`), so a claim tool would have no caller.

## 2. Reuse, not reimplementation

The extension was written with this in mind, and the split is already visible in its import graph: **thirteen of its thirty-one modules never import `vscode` at all.** Those are the candidates, and they are the interesting ones.

Portable as-is: `apps/vscode/src/cloud/client.ts` (the whole transport, including the refresh coalescing at `:49` that Supabase's rotating refresh tokens make mandatory), `apps/vscode/src/cloud/types.ts` (the single status vocabulary, `:10`), `apps/vscode/src/cloud/errors.ts`, `apps/vscode/src/cloud/session.ts` (already injected through two hand-written interfaces at `:20` rather than importing `SecretStorage`), `apps/vscode/src/tasks/queue.ts` (the dedupe-by-task retry queue and its backoff at `:30`), `apps/vscode/src/git/taskRefs.ts` (the whole reference grammar, `:113`), and `apps/vscode/src/storage/cache.ts`.

Portable after one small inversion: `apps/vscode/src/tasks/statusWriter.ts`, whose rule at `:58` that a 4xx rolls back and drops while a 5xx queues is the entire value of the module, and whose only editor coupling is the toast — take a `notify` callback. `apps/vscode/src/tasks/taskStore.ts` likewise: its generation counter at `:29` prevents a sign-out race and its only import is `vscode.EventEmitter`.

Not portable, and not wanted: the tree providers, the webview, the sign-in flow, the git bridge and watcher, and `extension.ts`. Those are the interface. `repoDocs.ts` sits on the line — its logic is portable but `:105` reads through `vscode.workspace.fs`, so the server reimplements the reader over `node:fs` and shares only the path list and the drift comparison.

**Arrange it as a workspace package.** `pnpm-workspace.yaml` currently lists `apps/*` only; add `packages/*` and create `packages/pz-cloud` holding the cloud client, errors, types, session, queue and task refs — roughly 740 lines, all six of which already have unit tests under `apps/vscode/test/unit/`. Both consumers then depend on it by `workspace:*`.

Be honest about the cost: a third build target, an esbuild bundle crossing a package boundary, and the extension's two unusual TypeScript settings (`erasableSyntaxOnly` and `allowImportingTsExtensions`, both in `apps/vscode/tsconfig.json`) must hold in the shared package too, because `node --test` type-strips rather than compiles. Perhaps a day of plumbing, and worth paying *for these modules specifically* and not more: the refresh coalescing and the 4xx rule are exactly the bugs that stay invisible until they bite and must only ever be fixed once. Duplicating the ~90 lines of prompt assembly, by contrast, is cheaper than generalising it, and this plan recommends duplicating that one.

## 3. Authentication without an editor

This is the hardest part, and the reason is structural. The extension's flow (`apps/vscode/src/auth/signIn.ts:77`) builds a callback from `env.uriScheme` plus its own extension id, hands it to the web login page as `redirect_uri`, and receives the one-time code back through a URI handler the editor registered with the OS. A headless server has no scheme, no handler and no editor to register one.

The cloud side is small and already built: `POST /desktop-auth/handoff` deposits the browser's Supabase session and `POST /desktop-auth/redeem` exchanges the opaque code for it, unauthenticated by design (`apps/cloud/app/api/desktop_auth.py:39` and `:54`). What it is not built for is polling. `HandoffStore` is in-process, single-instance, single-use, and its TTL is 120 seconds (`apps/cloud/app/desktop_auth_store.py:25`). A device-code flow would need a client-initiated code, a longer TTL, a poll endpoint distinguishing *pending* from *expired*, rate limiting on it, and a store surviving restart — new cloud surface on a router that today has two routes.

**Recommendation: a pasted code for the first version.** A `login` subcommand opens `{webUrl}/login?desktop=1&state=<random>` and prompts for the code. This needs no cloud change, because the login page already renders the code with a copy button for exactly the cases where a redirect never arrives. The `state` is still sent — the page gates the code display on it — but carries no security weight here, since the code never travels back through a URL; the single-use 120-second TTL is the whole control. It also sidesteps the scheme-hijacking exposure the allow-list at `apps/web/src/app/(auth)/login/page.tsx:35` documents and accepts. Revisit the device flow in M4 if the paste proves to be where people stop.

**Where the secret lives.** There is no `SecretStorage`. Reuse the approach in `apps/engine/src/keychain.ts`: the macOS `security` CLI and Windows DPAPI through PowerShell, both already written there, with `storeSecret`/`readSecret` at `:109` and `:114`. That module has **no Linux branch** — ADR 0019 names the gap — so Linux needs one, and the honest first answer is a `0600` file under the user's config directory. Say so plainly in the README: on Linux any process running as the same user can read the refresh token, and Windows DPAPI does not isolate from same-session applications either, so the guarantee is "not plaintext in your dotfiles," not "isolated from local software." Store only the refresh and access tokens — nothing a re-login cannot recover.

## 4. Transport and configuration

**stdio first; HTTP in M4.** ADR 0019 notes both are in the spec, but stdio is the one every target client can already launch, and the server must read the clone to answer `get_project_rules` — a remotely hosted endpoint cannot see the developer's disk, so a local process is a requirement of decision 5, not a convenience. Streamable HTTP earns its place later for one case: a workspace wanting a single shared endpoint, which then needs an OAuth resource-server story rather than a pasted token.

Configuration mirrors `apps/vscode/src/config.ts:36` name for name — `cloudApiUrl`, `cloudWebUrl`, `supabaseUrl`, `supabaseAnonKey` — read from a config file and overridable by environment variable, since an MCP client launches a bare process and cannot supply editor settings. Per-folder `projectId` has no analogue: the server takes a workspace-root argument, defaults to `cwd`, and resolves the project from the clone's git remote. `closeTasksFromCommits` and `commitScanLimit` do not apply — there is no watcher, and the server closes a task only when asked.

## 5. Milestones

**M1 — read-only stdio server.** Extract `packages/pz-cloud`; create `apps/mcp` with an stdio server, the `login` subcommand and the keychain-backed token store; implement `list_my_tasks` and `get_task`. A Neovim or JetBrains developer can now ask their assistant what they are working on and get the task with its acceptance criteria. Independently useful, and the smallest thing that is.

**M2 — the clone.** Workspace-root resolution and `get_project_rules`, reading the three seeded files over `node:fs` with the constitution stage document as provenance fallback. The developer's agent now gets the project's coding rules without being told them.

**M3 — the write.** `close_task` over the status PATCH, reusing the status writer's 4xx-versus-5xx rule and the persistent queue, with the artifact populated from the current `HEAD` when the caller supplies no commit. The loop closes; this is the milestone that makes the server a peer of the extension rather than a reader.

**M4 — reach.** Streamable HTTP behind an explicit flag; `registerMcpServerDefinitionProvider` in `apps/vscode` so VS Code users get the same tools without a second install; the install documentation on `apps/corp`; and the device-code flow if M1's paste proves to be where people stop.

## 6. Distribution

Publish to npm as a scoped package and document the one JSON block a developer pastes into their client's MCP configuration, invoked through `npx` so there is nothing to install or update by hand. Run `login` once; every client on the machine then shares the stored session.

**The marketplace constraint, stated exactly as ADR 0019 decision 6 states it:** Visual Studio Marketplace Participation Policies §3(b) forbids promoting our *other IDE offerings* inside the extension listing or its first-run walkthrough, so the MCP-for-JetBrains pitch lives on `apps/corp`. Note what this does not forbid: the extension may still register the server for VS Code users in M4, because that is a feature of the extension and not an advertisement for a competing editor.

## 7. Gating

This plan is downstream of [plan 0011](./0011-desktop-decision-gate.md), and the branch chosen there changes its urgency rather than its content. Under **Branch A (retire)** it becomes a release prerequisite sequenced ahead of the `apps/desktop` deletion — that plan's §4 says so directly, because deleting the shells removes the last thing a non-VS-Code developer could have installed. Under **Branch B (fund)** the shell keeps serving those developers in the interim, and this plan competes for the same effort as the rebuild and the operational floor. Plan 0011 recommends Branch A with this plan first; on that reading M1 through M3 are launch-blocking and M4 is not.
