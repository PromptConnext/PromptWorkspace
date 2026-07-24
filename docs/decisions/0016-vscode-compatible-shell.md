# ADR 0016 — Evolve the desktop shell to a VS Code–compatible base (Eclipse Theia), not a fork

**Date:** 2026-07-22 · **Status:** Proposed · Supersedes the shell/editor portions of [ADR 0001](0001-tauri-shell-node-sidecar.md) and realizes "step 2" of [ADR 0007](0007-cursor-like-workspace.md). Does **not** change ADRs 0003, 0006, 0008, 0009, 0010, 0014, 0015 in substance — it re-homes their host, not their contracts.

> Full analysis, options table, and sources: [`docs/research/vscode-shell-feasibility.md`](../research/vscode-shell-feasibility.md). This ADR is the decision of record and the implementation brief.

## Context

ADR 0007 committed PromptConnext to a Cursor-shaped workspace — business users in an Agents/Planner surface, developers in an integrated editor — and staged the path as: (1) Monaco editor + terminal inside the Tauri shell, then (2) "VS Code fork or embedded openvscode-server" for full extension-ecosystem parity, flagged as "the expensive cliff … a separate go/no-go."

Step 1 is **done**: the Tauri shell already hosts a Monaco editor (`EditorPane.tsx`), a file tree, and a real PTY terminal (`TerminalPane.tsx`) alongside the 3S flow. The open question is step 2, now sharpened by a product goal: a top-bar **Planner Window** that lets business users connect an LLM, chat to plan, generate tasks from requirements, and sync to the cloud — while developers get a genuine VS Code–grade IDE in the same app.

The pivotal finding from the research: **Cursor forked VS Code to modify editor internals** (inline multi-file diff overlays, speculative edit rendering, background agents in isolated VMs) — capabilities that are impossible as a plugin. **The Planner Window needs none of that.** Connect-a-model, chat-to-plan, generate-a-task-graph, and cloud-sync are all side-panel/command features fully served by the standard VS Code extension model (webviews, Chat Participant API, Language Model API). Forking would buy internals access we don't need while imposing a permanent upstream-rebase burden (Cursor staffs a team purely for this), Microsoft branding/licensing constraints, and loss of the Microsoft Marketplace (its ToS restricts extensions to Microsoft products; enforced in 2025 when the C/C++ tooling broke in forks).

## Decision

1. **Adopt a VS Code–compatible base, not a fork.** Primary target: **Eclipse Theia** packaged as an Electron desktop app — a framework explicitly built to assemble custom, rebrandable IDEs from the same foundation as VS Code, running VS Code extensions via **Open VSX**. Fallback (only if preserving the Tauri/Rust shell becomes a hard requirement): **openvscode-server embedded in the current Tauri webview**.

2. **Reject the hard-fork of VS Code / Code-OSS** (the Cursor path). It is out of scope. If a future requirement seems to need editor-internals changes, that is a red flag to push the need into the Planner extension or an upstream Theia contribution — not a shell patch.

3. **Preserve the Node engine unchanged.** The engine (Hono, `node:sqlite`, `node-pty`, BYO-model gateway, cloud sync, keychain-backed credentials) stays the local source of truth and keeps running as a spawned sidecar on `127.0.0.1:47131`. The origin-allowlist + per-session bearer model (ADR 0008) still governs it; the new shell's origin is added to the allowlist. Folding the engine into Theia's Node backend is explicitly deferred — keep the clean process boundary for now.

4. **Deliver the Planner Window as a first-party Theia extension/widget** over that same engine, and **standardize on the Open VSX Registry** for all third-party extensions. Where a required extension is Marketplace-only, find an Open VSX equivalent or vendor it.

5. **Sequence so value ships before any migration.** Gate the migration behind a time-boxed spike (M0); ship business-user value inside the *current* Tauri app first (M1); only then migrate the shell (M2–M4). Preserve a real off-ramp back to "stay on Tauri" if the spike disappoints.

## What stays vs. what moves

**Stays as-is (no code change required by this ADR):** the entire Node engine and its routes; the SQLite task graph (ADR 0003); the BYO-model gateway and Anthropic façade (ADR 0006); external-agent orchestration and Git commit-ref truth-keeping (ADR 0007/0009); cloud sync and the roster/membership model (ADR 0010/0015). Their HTTP/WS contracts are the integration surface and are honored verbatim by the new shell.

**Moves out of the Rust shell into the new shell's main process (this is the bulk of the work):**

- Engine spawn + lifecycle — today `spawn_engine`, PPID-watch, kill-on-exit in `lib.rs` → Electron main process (Theia). Keep passing `PROMPTCONNEXT_PARENT_PID` and `PROMPTCONNEXT_AUTH_TOKEN`; keep preferring a bundled Node.
- Session-token minting + injection — today `mint_token()` + `window.__PROMPTCONNEXT_TOKEN__` via `initialization_script` → Electron preload script. Same 32-hex CSPRNG token, same global name, injected before app scripts run (ADR 0008).
- OS keychain — today shells out to macOS `security`; ADR 0001 already flagged a cross-platform binding was needed. Use an Electron keytar-style binding (macOS Keychain / Windows DPAPI-backed) — this is easier off Rust, not harder.
- Deep-link `promptconnext://` handoff (ADR 0014) — today `tauri-plugin-deep-link` + single-instance argv relay → Electron `app.setAsDefaultProtocolClient` + `open-url` (macOS) / `second-instance` argv (Windows). Preserve the "paste the code manually" fallback for unbundled/dev runs.
- Auto-updater — today Tauri updater against the R2 bucket → `electron-updater` (or Theia packaging equivalent) against the same R2 assets.

## Milestones (implementation plan)

Each milestone is independently shippable and serves both personas. Sizes are relative; calendar ranges assume a small team and are planning aids, not commitments.

### M0 — Decision spike (1–2 weeks, no user-facing change) — **the migration go/no-go gate**
Stand up a bare Theia Electron build (and, in parallel, note what an openvscode-server-in-Tauri build would take). Spawn the existing engine as a sidecar against it, inject the session token via preload, add the shell origin to the engine allowlist, and open a project folder with the engine's file + terminal routes working end to end on **both macOS (arm64) and Windows (x64)**. Run the **Open VSX extension audit**: list the extensions developers actually need and confirm availability on Open VSX; flag any Marketplace-only critical dependency. Prototype the deep-link and keychain re-home approach enough to prove it is routine.

*Exit criteria:* engine + Theia + one placeholder Planner webview communicate over the token-authenticated loopback API on both OSes; the extension audit has no unresolved blocker; deep-link + keychain approach confirmed. **If any is ugly, stop and stay on Option A (Tauri) permanently** — M1 still ships either way.

### M1 — Planner Window in the *current* Tauri shell (2–3 weeks) — ships regardless of M0 outcome
No re-platforming. Promote the 3S flow into a named **Planner** surface reachable from `TopBar` (the requested "Agent Window from the top bar"). Add explicit connect-LLM, generate-tasks-from-requirements, and cloud-sync affordances, and tidy the business/developer split in the existing tabs. Business users get the requested experience immediately; developers keep the current Monaco + terminal.

*Exit criteria:* a business user can, from the top bar, connect a model, chat to plan, generate a task graph, and see cloud-sync status without touching code machinery.

**M1 delivered 2026-07-24** — see `docs/superpowers/specs/2026-07-24-planner-window-design.md` and `docs/superpowers/plans/2026-07-24-planner-window.md`. Existing 3S loop and affordances (ConnectForm, Task Graph, CloudConnect) reused as-is, no chat UI added.

### M2 — Theia app skeleton at plumbing parity with Tauri (3–5 weeks)
Turn the M0 spike into a real, packaged Theia desktop app: engine lifecycle, token injection, keychain, deep-link, and auto-updater all re-homed per "What moves" above; CI matrix (macos-latest arm64 + windows-latest x64), code-signing, and notarization re-established for the Electron bundler. No Planner yet — the goal is a distributable shell whose plumbing matches today's Tauri shell, running a genuine VS Code–grade editor + terminal for developers, with Open VSX wired as the extension registry.

*Exit criteria:* a signed/notarized Theia build installs on both OSes, boots the engine, authenticates over loopback, opens a real project, and passes the same "copied outside the repo, `node` stripped from PATH" self-containment check ADR 0001 defined for the Tauri bundle.

### M3 — Planner as a first-party Theia extension; unify both personas (3–5 weeks) — **the destination**
Port the M1 Planner into a Theia extension/widget over the same engine. Add a **"business mode" layout preset** (curated, de-cluttered — Planner primary, editor chrome minimized) so the IDE never intimidates a non-technical user; this is essential, not optional. Wire the developer command-palette actions (Copy context, point-agent-at-model env handoff, task-ref Git truth-keeping) into the Theia surface.

*Exit criteria:* one project, one engine, one task graph, two views — business users in the Planner/business-mode layout, developers in the full IDE — both working against the same local state.

### M4 — Cutover & polish (2–4 weeks)
Migrate users from the Tauri build to Theia, retire the custom Monaco/xterm panes, finalize Open VSX extension recommendations, and update this ADR set (mark the shell/editor parts of 0001/0007 superseded). Optionally revisit folding the engine into Theia's backend as a later optimization (not required).

## Consequences

- **Positive:** developers get a real, extensible VS Code–grade IDE; business users get a first-class, layout-curated Planner Window; the differentiated engine is untouched and portable; licensing sits cleanly on Open VSX with no Microsoft exposure; and ongoing cost is a normal framework-upgrade cadence rather than a permanent rebase treadmill.
- **Negative / accepted trade-offs:** Electron replaces Tauri, so binaries and memory grow (accepted industry norm for an IDE, but a regression from today's lean shell); code-signing/notarization must be re-established for the new bundler (historically painful); some M1 investment in the Tauri Monaco/xterm panes is retired at M4 (intentional — value now vs. migration later); the security model (ADR 0008 allowlist + terminal-WS CSWSH protection) must be re-verified, not copy-pasted, on the new origin story.
- **Dependency risk:** Open VSX has smaller coverage than the Microsoft Marketplace and has had past availability incidents; the M0 audit exists to surface any blocker before commitment.

## Alternatives rejected

- **Fork VS Code / Code-OSS (Cursor path).** Rejected: permanent upstream-rebase cost, Microsoft branding/Marketplace constraints, and it only buys editor-internals access the Planner Window does not need.
- **Stay on Tauri + keep hand-building Monaco.** Kept as the M0 off-ramp and as M1, but rejected as the *destination*: developers never get the extension ecosystem, language servers, or debuggers, and we keep re-building a fraction of VS Code by hand — exactly the "don't rebuild an editor" roadmap risk ADR 0001 named.
- **Ship the Planner only as an extension for users' own VS Code.** Rejected as the product (business users can't be asked to install VS Code first; non-MS-host distribution hits the Marketplace ToS wall), but retained as a possible complementary distribution channel later.

## Notes for the implementing agent (Sonnet)

- Treat the engine's HTTP/WS API as a frozen contract; do not modify engine routes to suit the shell. If the shell needs something the engine doesn't expose, raise it explicitly rather than reshaping existing endpoints.
- Reproduce ADR 0008 exactly on the new shell: same token shape, injected before any app script, same allowlist enforcement, same terminal-WS origin close-before-spawn. Add a test that a non-allowlisted origin is rejected.
- Keep macOS **and** Windows in every milestone's exit criteria — packaging is host-platform-bound (bundled Node + `node-pty` prebuild), and that constraint persists under Electron.
- Do not introduce a build step for the engine and do not fold it into Theia's backend in this ADR's scope.
- When a task tempts you toward editing an editor internal, stop: that is the Option D on-ramp this ADR forbids. Route it through the Planner extension or upstream Theia.
