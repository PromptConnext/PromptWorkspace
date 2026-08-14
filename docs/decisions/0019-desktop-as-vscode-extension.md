# ADR 0019 — Replace the desktop application with a VS Code extension, plus an MCP server for everyone else

**Date:** 2026-08-13 · **Status:** Proposed · **Deciders:** product + engineering

**Prompted by the decision:** *given that the cloud now owns planning and the desktop's job is narrowed to executing assigned tasks against a local repository, is a VS Code extension sufficient — rather than building and maintaining a standalone desktop application?*

**Answer: yes, and more than sufficient.** Under the narrowed responsibility the extension is not a compromise against the desktop app; it is a smaller, cheaper and better-distributed artifact that does the job more completely.

**Supersedes:**

- **ADR 0016** (Theia shell) entirely. Its reasoning was sound for the product it was written against — a two-persona app where business users planned inside the desktop. That product no longer exists. `apps/desktop-theia` is retired before M3.
- **ADR 0001** (Tauri shell + Node sidecar) and **ADR 0007** (Cursor-like workspace) on the shell and embedded-editor questions. `apps/desktop` is retired.
- **ADR 0006** (Anthropic-compat façade) and **ADR 0009** (orchestrate external agents) in part — see "What the engine loses" below. The BYO-*model* gateway is retired; BYO-*agent* survives in a different shape.

**Depends on:** [ADR 0020](0020-cloud-is-the-source-of-truth.md). This ADR is only coherent if the cloud is authoritative; do not implement it first.

---

## Context

### The question got easier, because the job got smaller

A previous draft of this ADR evaluated a VS Code extension against a desktop app that had to host a business-user planning surface behind a blocking sign-in gate. That comparison was genuinely close, and it came out "keep both." The considerations that made it close were: VS Code offers no full-window blocking gate; you cannot brand the title bar, the activity bar or the window chrome; and roughly 1,900 of the desktop's 4,237 lines were business-facing surface that has no natural home in an IDE sidebar.

Every one of those considerations was about the business persona. Under the new direction the business persona is not on the desktop at all — they are in `apps/web`, reviewing progress through a deployed preview environment that requires no development machine. What remains is a developer tool for developers, and for a developer tool the editor is not a rented room. It is the correct address.

### The narrowing removes the last technical objection

The strongest engineering argument against an extension was that PromptConnext needs a local Node sidecar, and the VS Code extension host is a hostile place to own one: `deactivate()` is capped at a hard-coded five seconds and is never called on disable, uninstall or update; nothing reaps grandchildren, so a spawned engine survives window close, **Reload Window**, and crash. This is a long-declined class of issue — microsoft/vscode#11895 is from 2016, and #305999 and #306129 were closed *not planned* in 2026 — and Microsoft's own extensions leak processes because of it. Native modules made it worse: Node 24 is ABI 137, the Electron 42 that VS Code 1.123+ ships is ABI 146, so a `.node` built against stock Node will not load in the host despite both being "Node 24."

Under the narrowing, none of that applies, because **there is no sidecar left to own.**

`node-pty` is the engine's only native npm dependency — the package manifest lists four dependencies, three of which are pure-JS Hono packages. Its sole consumer is `apps/engine/src/routes/terminal.ts`, which exists to serve a hand-built xterm pane that VS Code's integrated terminal replaces outright. Delete that file and the native dependency leaves the tree. `node:sqlite` has one consumer, `db.ts`, and it is a Node built-in rather than a native module. Everything else the engine does is `fetch`, `execFileSync("git", …)`, and `sh -c "command -v claude"`. All of that runs inside the extension host directly.

Sorting the engine's 4,775 lines against the narrowed job:

| Fate | Roughly | What |
|---|---:|---|
| Dead — local planning the cloud now owns | ~2,000 | `agent/loop.ts` (`runStage`, `runImplementation`) and its six Spec Kit templates; the constitution/scope/spec/tasks/approve routes in `routes/projects.ts`; `routes/models.ts`; `routes/onboarding.ts`; `gateway/index.ts`; `backups.ts` |
| Dead — served the hand-built editor | ~224 | `routes/files.ts` (139), `routes/terminal.ts` (85) |
| Survives | ~1,500 | `cloudClient.ts` (359), `routes/cloud.ts` (486), `security.ts`, `config.ts`, `keychain.ts`, the agent adapters' `detect()` half, `anthropic-compat.ts`, and the git/project-shell helpers |
| Inverts rather than dies | ~900 | `sync/loop.ts`, `db.ts` — see ADR 0020 |

The ~1,500 that survives is a cloud API client, a token store, a git wrapper and some CLI detection. That is an extension, not a server.

---

## Decision

**1. Build the developer experience as a VS Code extension with no sidecar.** The surviving engine logic moves into the extension host as ordinary modules. There is no spawned process, no bundled Node runtime, no `node-pty`, no loopback HTTP server, and therefore no origin allowlist, no session bearer token, no daemon mode and no PID-lock reclaim. ADR 0008's threat model — a web page reaching a loopback server — disappears with the server.

**2. Retire both shells.** `apps/desktop` (Tauri) and `apps/desktop-theia` (Electron/Theia) are deleted. ADR 0016's M3 and M4 are cancelled rather than reordered; M0 and M2 produced real knowledge and a passing spike, and that is what they were for.

**3. Ship an MCP server as the portable second channel.** MCP is the one AI-integration protocol honored across VS Code, Cursor, Windsurf, Claude Code, Theia and the JetBrains AI assistants, and VS Code implements the full spec including stdio and HTTP transports, tools, resources, elicitation and OAuth. A developer in Neovim, Zed or IntelliJ gets their assigned tasks, project context and coding rules, and can close a task, through the assistant they already run. This is a small artifact over the same cloud API — not a second UI — and it doubles as the mechanism in decision 5.

**4. Use only stable, fork-portable VS Code APIs for anything load-bearing.** No proposed APIs: they cannot be published at all, and the escape hatch is a `product.json` allowlist only Microsoft controls. Build the UI on tree views, webview views, the Comments API, SCM, `SecretStorage`, `registerUriHandler` and commands. Treat `vscode.chat` and `vscode.lm` as progressive enhancement only — they are **present but inert** in Cursor and Windsurf and *stubbed* in Theia, so `typeof vscode.lm !== 'undefined'` is a false positive and the observed failure is a runtime `LanguageModelTextPart is not a constructor`. Feature-detect by calling and checking results.

**5. Hand tasks to the developer's assistant; stop orchestrating it.** ADR 0009 chose to spawn the developer's agent CLI headless and capture results from `git status --porcelain`. That made sense when we owned the window. Inside the editor the developer's agent is already running, already has the workspace, and already has a model. Our job narrows to *supplying context and receiving outcomes*: expose the task graph, the constitution and `AGENTS.md` through `lm.registerTool` on VS Code and through the MCP server everywhere, and keep a copy-context command as the universal fallback. Retire `agent-runner.ts` and the spawn half of the adapters; keep `detect()`.

**6. Publish to the Microsoft Marketplace and Open VSX from day one.** Marketplace reaches VS Code; Open VSX reaches Cursor, Windsurf, VSCodium and code-server. Two obligations: Publisher Agreement §8(d) permits bundled or spawned executables only as disclosed in the listing — with no sidecar we have little to disclose, which is itself a benefit — and Participation Policies §3(b) forbids promoting our other IDE offerings inside the listing or first-run walkthrough, so the MCP-for-JetBrains pitch lives on `apps/corp`.

---

## How each workflow lands

**Pull assigned tasks.** A `TreeView` grouped by project, backed by the cloud read path ADR 0020 specifies. `TreeItem.checkboxState` is stable since 1.80 and is the natural affordance for "done". Until a "my tasks" endpoint exists the client walks workspaces → projects → graph and filters on `assigned_user_id`; that is acceptable for a first cut and is called out as a gap in ADR 0020.

**Display project context and AI coding rules.** Read `AGENTS.md`, `docs/conventions.md` and `.specify/memory/constitution.md` **from the clone**, not from an API. The cloud seeds them once at tech-review exit under a preamble that says "edit freely — never overwritten" (`app/integrations/repo_seed.py`), so git is the distribution channel by design and the file is what the developer's own agent will read anyway. Render in a webview view, with the cloud's `stage-documents/constitution` available as provenance when the file and the document have drifted.

**Git integration.** Consume the built-in extension — `extensions.getExtension<GitExtension>('vscode.git').exports.getAPI(1)` plus `"extensionDependencies": ["vscode.git"]`. It gives `state.HEAD`, `refs`, `remotes`, working-tree and index changes, `log`, `blame`, the full diff family, and `toGitUri`. It is also the least stable dependency in the stack: it appears nowhere in the published API reference, its README tells you to *copy* `git.d.ts` into your sources, and it has shipped breaking changes inside `getAPI(1)` without deprecation. Vendor a pinned copy behind an internal interface, exactly as Microsoft's own PR extension does. Cloning from the plan-provisioned origin (ADR 0017) is `git.clone()` or a `git` subprocess; the existing `assertCloneableRepoUrl` guard should move across.

**Task status sync — the new requirement, and the part that gets best.** Two paths, both landing on ADR 0020's status endpoint. Explicit: check the box in the tree, or run a command. Implicit: `syncTasksFromGit` — which today scans the last 300 commit subjects for `\bT\d{3}\b`, attaches an artifact and marks the task done — moves into the extension, where `vscode.git`'s `log` and repository state-change events replace `execFileSync`. A developer commits `T003: add retry`, pushes, and the task closes in the cloud with no context switch at all. That is a better answer to the stated requirement than a button, and the mechanism already exists.

**Hand off to the AI assistant.** Three tiers. On VS Code, `lm.registerTool` puts the task graph and coding rules in front of whatever agent the user runs in native chat, and `registerMcpServerDefinitionProvider` registers our MCP server for them. Everywhere in the VS Code family, the MCP server works directly. Everywhere else, a "copy task context" command that assembles the task, its acceptance criteria, the relevant spec excerpt and the constitution into the clipboard — unglamorous, universal, and the thing developers will actually use most.

**Auth (ADR 0014).** Simplifies. `window.registerUriHandler` + `onUri` replaces `tauri-plugin-deep-link`; the scheme must come from `env.uriScheme` and never be hardcoded, since Insiders, Cursor, Windsurf and VSCodium all differ — the same lesson ADR 0016's 2026-08-01 amendment learned, and the `PROMPTCONNEXT_DEEP_LINK_SCHEME` handoff it built is exactly the mechanism, now sourced from the editor. Build the callback with `env.asExternalUri()` or remote and browser hosts break. One trap that we happen to survive: the URI fragment is dropped in `handleUri` (microsoft/vscode#141640), so a token returned in `#` would be lost — ours returns `?code&state`. Keep the manual paste-code fallback; Linux deep links are genuinely unreliable. ADR 0015's membership gate becomes a sidebar sign-in view rather than a full-window takeover, which for a developer audience is not a downgrade.

**Secrets.** `ExtensionContext.secrets`, stable since 1.53, replaces `keychain.ts` — including the Linux gap that module never implemented. Know what you are getting: keytar was replaced by Electron `safeStorage`, which puts one app-wide key in the OS keychain and per-extension ciphertext in the ordinary `state.vscdb`. Per-extension isolation is namespacing, not a security boundary; Windows DPAPI does not isolate from other apps in the same session; and on Linux with no available keyring VS Code falls back to **in-memory storage, so secrets vanish on window reload**. For a refresh token that means an occasional re-login, which is tolerable. Do not store anything there that a re-login cannot recover.

---

## What we give up, honestly

**Branding on the developer surface.** We get a container and one 24×24 monochrome activity-bar icon. No title bar, no window chrome, no splash, no custom CSS — the platform documents this as policy, not oversight. Under the old direction this was the decisive cost. Under the new one, product control lives in `apps/web` and the cloud, which we own end to end, and the developer surface is one we were never going to out-design VS Code on.

**A guaranteed always-on process.** With no sidecar there is nothing running when the editor is closed. Anything that must run unattended belongs in the cloud, which is where ADR 0020 puts it anyway.

**Some review-UI polish.** The Comments API core is stable and sufficient for inline review — `createCommentController`, `CommentThread` with resolved state, commenting-range providers, and file-level comments. What is proposed-only, and therefore closed to us, includes outdated-thread markers, draft/batched review state and multi-diff tab lifecycle. Roughly twelve of the twenty-eight proposals the GitHub PR extension enables are comment-related; expect complete but plainer.

**The BYO-model gateway.** `gateway/index.ts` is retired with local planning. The Anthropic-compat façade (ADR 0006) is worth keeping *if* it is re-sourced — its value is pointing a developer's Claude Code at the team's connected model, but it currently resolves credentials from the local `model_connections` table that `routes/models.ts` owns, and that table dies. Either re-point it at a cloud-held connection or retire it with the rest; do not leave it resolving from a deleted source. `GET /engine/local-llm-env`, which emits the `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` pair a developer pastes into their own CLI, is the cheap version of the same idea and should survive as a command.

**Developers outside the VS Code family** get the MCP server rather than a first-class UI. That is decision 3, and it is a deliberate floor, not an oversight — but it is a floor. If JetBrains turns out to be a large segment, a plugin is a separate project and this ADR does not pre-judge it.

---

## Onboarding, maintenance and distribution

For the only audience the desktop now serves, the extension wins on every axis. Install is one click inside an editor the developer already trusts, with auto-update on by default. The desktop app asks for a download, an unsigned-app warning, a Gatekeeper override and a second sign-in — and our macOS signing gap is not hypothetical: `desktop-theia-build.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY: false` and `"identity": null`, and `update-lifecycle.js` documents macOS auto-update as expected-non-functional until notarization, leaving an sha512 checksum served from the same origin as the payload — a corruption check, not an authenticity one. Retiring the shells closes that gap by deletion rather than by finally paying for it.

On maintenance, the trade is Microsoft's CDN, auto-update, malware scanning and block list in exchange for API drift and registry compliance. The compliance items are real and one is dated: **global Azure DevOps PATs retire 2026-12-01**, so publishing CI must move to Entra ID workload identity federation with `vsce publish --azure-credential`. Against that, we stop operating two CI matrices, two code-signing stories, an R2 release bucket and an update manifest.

The residual API-drift cost is small and concentrated: a vendored `git.d.ts`, an `engines.vscode` floor that gates which users receive updates, and dual publishing. There is no VSIX size concern without a bundled runtime — which was the one unresolved blocker in the previous draft, and the narrowing removes it.

---

## Recommendation

**Option 1 — replace the desktop application entirely with a VS Code extension**, with an MCP server as the portable channel for developers outside the VS Code family.

This is a reversal of the previous draft's "keep both," and the reason is not that the platform analysis changed. It is that the product changed underneath it. "Keep both" was purchased almost entirely by the business persona and the branding that persona justified. Remove them and the case collapses: what is left is a developer tool whose every responsibility — Git, local repository, AI assistant handoff, task sync — is native to an editor extension and foreign to a standalone window.

The two alternatives, for the record:

**Keep both, extension primary (the previous recommendation)** is now paying for a shell that serves nobody the cloud does not serve better. Its remaining argument is branding on a surface where branding does not convert, and it costs two CI matrices, a signing story we have not finished, and a Theia migration whose M3 has not started. Rejected.

**Continue with the shell (ADR 0016 as written)** requires building the Planner into Theia — a planning workflow the cloud now owns. It would be building the wrong thing well. Rejected, and ADR 0016 is superseded rather than amended, because its premise rather than its reasoning is what failed.

One honest caveat on sequencing: this ADR depends on ADR 0020, and ADR 0020's cloud gaps — a status endpoint, a "my tasks" read, the `spec_id` foreign key, the status vocabulary — are prerequisites, not follow-ups. An extension built before them can display tasks but cannot close them, which is the requirement that motivated this whole revision. Do not start the extension until the status write exists.

---

## Consequences

- **Positive:** roughly 2,200 lines of engine become deletable outright and two host shells with them; the last native dependency and the entire loopback-server threat model disappear; distribution moves to a channel we neither operate nor pay for; the unsigned-macOS problem is closed by deletion; and task status closes from a git commit, which is the least intrusive possible answer to the stated requirement.
- **Negative / accepted trade-offs:** no branded surface for developers and no always-on local process. Review UI will be plainer than GitHub's. Non-VS-Code developers get MCP rather than a UI. `vscode.git` is an unversioned dependency we must vendor and watch.
- **Sunk cost, stated plainly:** ADR 0016's M0 spike and M2 plumbing — 414 lines plus a working `electron-builder` CI with Windows signing — are written off. M0 was a go/no-go gate that returned real information, including the Open VSX audit that now informs decision 6. That is what a spike is for.
- **Open questions to validate rather than assume:** whether JetBrains or Neovim represent a material share of target developers (the MCP floor is sized for "some", not "many"); and whether the deployed preview environment creates any local-side requirement not yet visible, since it is described as wholly cloud-owned.

## Alternatives rejected

- **A web-based developer client instead of an extension.** Rejected: the job is local Git and local files, which a browser cannot reach without an agent installed — reintroducing exactly the local process this ADR removes.
- **Keeping the sidecar for safety.** Rejected: it re-imports the entire orphan-process and ABI problem to host ~1,500 lines of `fetch` and `execFile`. If something later genuinely needs a daemon, that is a decision to revisit with a concrete driver, not a hedge to carry now.
- **Building on the Chat Participant API as the primary UI.** Rejected: inert in Cursor and Windsurf, stubbed in Theia, and the interesting half of the stream surface lives in the unpublishable `chatParticipantAdditions` proposal. Kept as VS Code-only enhancement.
- **Publishing only to Open VSX.** Rejected: it forfeits the main reason to build an extension. Publishing to the Microsoft Marketplace is permitted — the Terms-of-Use restriction ADR 0016 cited governs which *products may consume* the Marketplace, which was a constraint on the Theia shell, never on us as a publisher.
- **Porting the desktop React verbatim into a webview.** Rejected: roughly 1,900 of those lines are the business surface, and most of the rest is the editor, tree and terminal that VS Code provides natively. Rebuild the ~2 views that remain against native primitives.

## Notes for the implementing agent

- **Do not start before ADR 0020's status write exists.** An extension that shows tasks but cannot close them fails the requirement that prompted this ADR.
- There is no sidecar. If a design step reaches for one, stop and raise it — the absence of a local server is what makes this ADR cheap, and reintroducing it silently would restore every objection it removes.
- Vendor `git.d.ts` at a pinned VS Code version and wrap it behind an internal interface. Never call the raw Git extension API from feature code.
- Feature-detect `vscode.lm` and `vscode.chat` by **invoking and checking results**, never by `typeof`. Every enhancement path needs an MCP or copy-context fallback exercised in CI.
- Move `syncTasksFromGit` across but fix its two edges while you are there: the `\bT\d{3}\b` regex silently ignores `T12` and `T0003`, and the 300-commit scan window means an old close can fall out of range. Prefer `vscode.git`'s repository state-change events over a scan-on-read.
- Extract `commitFiles()` from `agent/loop.ts` and `changedFiles()` from `agent-runner.ts` before deleting either file. `commitAll()` has no caller outside the dead stage runners and can go with them.
- Publish the VSIX from Linux or macOS. Packaging from Windows strips the POSIX executable bit from bundled files — harmless with no sidecar, but it will bite the moment anything ships an executable.
- Retire `apps/desktop` and `apps/desktop-theia` in one deliberate change with the ADR references in the commit message, and delete their two CI workflows and the R2 release paths with them. Leaving a dead build pipeline running is how the next reader concludes the shells are still alive.
