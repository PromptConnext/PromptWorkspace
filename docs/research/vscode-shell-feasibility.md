# Feasibility: Evolving the PromptConnext Desktop App into a Cursor-like, VS Code-based Experience

**Status:** Research / proposal for a go-no-go decision · **Date:** 2026-07-22 · **Author:** research pass for Logic Spark

> This document weighs whether PromptConnext should evolve its Tauri desktop app toward a Cursor-style, VS Code-based workspace that serves business users (a "Planner Window") and developers (a real IDE) in one shell. It ends with a recommendation, a migration path, effort sizing, licensing analysis, and a phased plan that starts from the smallest viable milestone. It builds directly on ADR 0001 (Tauri shell + Node sidecar) and ADR 0007 (Cursor-like workspace), which already anticipated this exact fork in the road.

---

## 1. Bottom line up front

**Conditional GO — but not the way Cursor did it.**

Evolving toward a VS Code-compatible workspace is a sound long-term direction and is consistent with the vision already written into ADR 0007. However, the research strongly recommends **against forking VS Code / Code-OSS** (the literal Cursor path) and **in favour of adopting a VS Code-*compatible* base that is designed to be embedded and rebranded** — with **Eclipse Theia** as the primary candidate and **openvscode-server-in-Tauri** as the fallback. In both cases the **existing Node engine is preserved** as the local sidecar; only the *shell and UI layer* changes.

The single most important finding: **Cursor forked because it needed to modify the editor's C++/TypeScript internals** — inline diff overlays, speculative edit rendering, background agents running in isolated VMs. **PromptConnext's Planner Window needs none of that.** A side-panel chat that plans projects, generates a task graph, and syncs to the cloud is squarely within what the standard VS Code extension model already supports. That means PromptConnext can get the developer-facing "it's a real VS Code" experience *and* the business-facing Planner Window **without paying the fork-maintenance tax** that a dedicated team at Cursor exists solely to service.

The recommendation is therefore staged so that **no re-platforming is required to ship value first**: the smallest milestone upgrades the Planner Window inside the *current* Tauri shell (both personas already coexist there today via the Monaco editor and PTY terminal), and the VS Code-grade developer surface is introduced behind a spike before any migration is committed.

**Recommendation in one line:** keep the engine, keep shipping in Tauri now, prove Theia in a time-boxed spike, then migrate the shell to Theia with the Planner as a first-party extension — and treat a VS Code hard-fork as explicitly out of scope.

---

## 2. Where PromptConnext is today

The current desktop app is already further along the ADR 0007 path than the phrasing "evolve into a Cursor-like experience" implies. It is worth being precise, because it changes what "evolution" actually costs.

The shell is a **Tauri 2 window** (thin Rust process, `apps/desktop/src-tauri/src/lib.rs`) that mints a per-session bearer token, spawns the **Node engine sidecar** on `127.0.0.1:47131`, and hosts a **React/Vite webview**. The webview already renders a two-persona workspace:

- **Business surface** — a global `TopBar` (workspace switcher, project tabs, account) above the **3S flow** (`ThreeS.tsx`): Scope → Spec → Skill, with generate/approve/regenerate gates, a live task graph, and cloud-linked project navigation (ADR 0015 membership gate).
- **Developer surface** — already present as tabs inside the same project view: a **Monaco editor** with a file tree and Git-status dots (`EditorPane.tsx`), and a **real PTY terminal** over WebSocket (`TerminalPane.tsx`) where developers run their own agent CLIs and paste the BYO-model env exports.

In other words, PromptConnext has *already executed step 1* of ADR 0007's staged plan ("Monaco editor + file tree inside the existing Tauri shell") and part of the integrated-terminal work. What the user is really asking about is **ADR 0007's step 2 — "VS Code fork or embedded openvscode-server for full extension-ecosystem parity"** — which that ADR itself flagged as "the expensive cliff … only if Monaco proves insufficient."

So the honest framing of this research is: *has Monaco-plus-terminal proven insufficient enough to justify climbing the cliff, and if so, which route up the cliff is least costly?*

---

## 3. The real decision, reframed

"Become like Cursor" bundles three separable decisions. Teasing them apart is what makes a clean go/no-go possible.

1. **Do we want a VS Code-grade developer surface** (full extension ecosystem, real language servers, debuggers, settings, keybindings) instead of a hand-built Monaco editor? — This is the substantive question.
2. **Do we want an "Agent Window / Planner Window" reachable from the top bar** for business users? — This is achievable on *any* of the base options, including the current Tauri shell, and is not by itself a reason to change architecture.
3. **Do we need to modify the editor's internals** (the reason Cursor forked)? — For the Planner Window vision as described, **no.**

Once (3) is answered "no," the fork option loses most of its justification, and the decision collapses to: *which VS Code-compatible base gives developers a real IDE with the least maintenance and licensing risk, while letting us bolt on the Planner Window and keep the engine?*

---

## 4. Architecture options compared

Five realistic architectures, from least to most disruptive. Ratings are relative.

| # | Option | Dev-surface fidelity | Fork/upstream tax | Preserves Tauri | Preserves Node engine | Effort | Licensing risk |
|---|--------|------|------|------|------|------|------|
| **A** | **Stay Tauri, upgrade the Planner Window + Monaco** | Low–Med (Monaco, no ext ecosystem) | None | ✅ | ✅ | **S** | None |
| **B** | **Embed `openvscode-server` inside the Tauri webview** | High (real VS Code UI + Open VSX extensions) | Low (track releases, no source edits) | ✅ | ✅ | **L** | Low (Open VSX) |
| **C** | **Adopt Eclipse Theia (Electron desktop)** — *recommended* | High (VS Code-compatible, Open VSX, purpose-built to embed/rebrand) | Low (consume as framework, don't fork) | ❌ (replaces Tauri with Electron) | ✅ | **L** | Low (EPL/MIT, Open VSX) |
| **D** | **Fork VS Code / Code-OSS (the Cursor path)** | Highest (edit internals) | **High (permanent rebase team)** | ❌ | ✅ | **XL** | Med–High (branding, marketplace) |
| **E** | **Contribute Planner as a plain VS Code extension for users' own VS Code** | N/A (no owned shell) | None | n/a | Partially | **M** | Med (marketplace ToS on non-MS hosts) |

### Option A — Stay Tauri, upgrade in place
Keep everything, and invest the next increment in the Planner Window (a proper top-bar "Agent Window" over the 3S flow) plus incremental Monaco improvements (multi-root, search, diff view, extension-like niceties hand-built as needed). **Pro:** zero architectural risk, preserves the small Tauri binaries and the Rust keychain/token design (ADR 0001, 0008), ships fastest. **Con:** developers never get the real extension ecosystem, language servers, or debuggers — you are permanently rebuilding a fraction of VS Code by hand, which ADR 0001's "roadmap risk #3" explicitly warned against. Good as a *first* milestone, insufficient as the *destination* if the developer persona matters.

### Option B — `openvscode-server` inside the Tauri webview
`openvscode-server` runs upstream VS Code as a server reachable from a browser; you would point the Tauri webview at a locally-spawned instance. **Pro:** a genuine VS Code UI and the Open VSX extension ecosystem, while *keeping the Tauri shell and the Rust process model*. It tracks upstream by consuming released server builds rather than editing source, so there is no rebase treadmill. **Con:** you now run *two* local servers (the engine and the VS Code server), the integration surface (auth, file access, PTY ownership, single-window lifecycle) is fiddly, and driving a browser-hosted IDE from a Tauri shell is a less-trodden path than Theia's Electron packaging. Viable, and the best choice *if preserving Tauri is a hard requirement*.

### Option C — Eclipse Theia (Electron) — **recommended**
Theia is an Eclipse Foundation framework explicitly built to **assemble custom desktop and browser IDEs** from the same four foundational components as VS Code; it runs VS Code extensions via **Open VSX**, ships as Electron for desktop, and is designed to be **rebranded and extended** rather than forked. You would build a Theia-based desktop app, contribute the Planner Window as a Theia **widget/extension**, mount the existing developer surfaces (editor, terminal, file tree) from Theia's built-ins, and **keep the Node engine as a sidecar** exactly as today. **Pro:** full IDE fidelity for developers, a first-class extension model for *your own* Planner UI, a vendor-neutral licensing/marketplace story, and no fork maintenance — you consume Theia as a dependency and upgrade it like any framework. **Con:** it replaces the Tauri/Rust shell with **Electron**, which means larger binaries, higher memory, and re-homing the pieces currently in Rust (session-token injection, keychain via `security` CLI, deep-link `promptconnext://` handling, the auto-updater, engine spawn/kill lifecycle). That re-homing is the real cost and is sized in §8.

### Option D — Fork VS Code / Code-OSS (what Cursor did)
Fork the MIT-licensed Code-OSS repo, edit its internals, and rebrand. **This is the option to reject.** The Eclipse Foundation's own analysis ("Why Cursor, Windsurf and co fork VS Code, but shouldn't") and multiple deep-dives converge on the same point: a fork means **permanently merging Microsoft's monthly releases into a diverging codebase** — Cursor staffs a team purely to "keep the lights on" with upstream merges. You inherit branding/licensing constraints (the Microsoft product license and logos are *not* MIT — only the Code-OSS source is), you **cannot use Microsoft's Marketplace** (its ToS restricts extensions to Microsoft products; in 2025 Microsoft actively enforced this, breaking the C/C++ tooling in Cursor and other forks), and you take on governance risk. The only reason to pay all this is to modify editor internals — which the Planner Window does not require.

### Option E — Ship the Planner as a plain VS Code extension
Instead of owning a shell, publish a VS Code extension that provides the Planner Window (a webview/sidebar) and talks to the engine. **Pro:** meets developers in the IDE they already use; lowest shell cost. **Con:** you don't own the experience, business users must install VS Code first (a non-starter for a non-technical persona), and distributing to non-Microsoft hosts runs into the same Marketplace ToS wall. Worth keeping as a *complementary* distribution channel, not the product.

---

## 5. Why the extension model is enough (the pivotal finding)

The instinct that "to be like Cursor we must fork like Cursor" is the trap to avoid. Cursor forked to get **root access to rendering, the file system, and the extension host** so it could do things that are *architecturally impossible* as a plugin — real-time speculative suggestions, inline diff overlays across multiple files, and background agents in isolated VMs.

PromptConnext's Planner Window, as specified, is a different animal:

- **Connect to an LLM** → already the engine's BYO-model gateway (ADR 0006/0009). A panel calls the engine; no editor internals involved.
- **Chat to plan a project** → a webview/sidebar panel. Fully supported by VS Code's webview and (since 2024–25) the **Chat Participant** and **Language Model** extension APIs.
- **Generate tasks from requirements** → an engine call rendering the task graph in a custom view. Standard tree/webview territory.
- **Manage tasks / sync to cloud** → engine + cloud sync (ADR 0010), surfaced in a panel.

Every one of these is a *side-panel and command* feature, not an *editor-internals* feature. That is exactly the class of thing the extension API is for. (Caveat worth noting: Cursor and Windsurf, being forks, have *dropped* support for VS Code's own Chat Participant API in favour of their bespoke chat — a reminder that forking fragments you *away* from the ecosystem, not toward it. Building on Theia/Open VSX keeps you aligned with the standard.)

Conclusion: PromptConnext can deliver the Planner Window as a **first-party extension on a VS Code-compatible base**, giving developers a real IDE and business users their Agent Window, with the engine untouched — and skip the fork entirely.

---

## 6. Engine & re-platforming: what changes, what stays

You indicated openness to re-platforming the engine boundary. The good news is that the recommended path needs very little of it.

**Stays as-is.** The Node engine (Hono, `node:sqlite`, `node-pty`, the BYO-model gateway, cloud sync, keychain-backed credentials) remains the local source of truth and keeps running as a spawned sidecar on `127.0.0.1:47131`. Its origin-allowlist + bearer-token security model (ADR 0008) still applies; you simply add the new shell's origin to the allowlist. Nothing about ADRs 0003, 0006, 0009, 0010, 0015 needs to change. This is the biggest de-risking factor: **the hard, differentiated part of the product — the engine — is portable across every option above.**

**Moves (only under Option C/D, i.e. leaving Tauri).** The responsibilities currently in the Rust shell must be re-homed into the new shell's main process:

- **Engine spawn/lifecycle** (`spawn_engine`, PPID-watch, kill-on-exit) → Electron main process (Theia) or the VS Code server's host.
- **Session-token minting + injection** (`window.__PROMPTCONNEXT_TOKEN__`) → Electron preload script / Theia backend contribution.
- **OS keychain** — today it shells out to macOS `security`; ADR 0001 already flagged this needs a cross-platform binding for Windows/Linux anyway. Electron has mature keytar-style options; this is arguably *easier* off Rust.
- **Deep-link `promptconnext://` handoff** (ADR 0014) → Electron's `app.setAsDefaultProtocolClient` + `open-url`/`second-instance` events. A well-trodden Electron path.
- **Auto-updater** (Tauri updater against R2) → Electron autoUpdater / `electron-updater`, or Theia's packaging pipeline. Requires re-doing the CI matrix (§8) but is standard.

**Boundary option worth considering.** If you go to Theia, you *could* fold parts of the engine into Theia's own Node backend (Theia already runs a Node process). This is tempting but the research recommendation is to **keep the engine as a separate sidecar** for now: it preserves the clean process boundary, keeps the security model intact, and avoids coupling your differentiated engine to Theia's release cycle. Fold-in can be a later optimization, not a migration prerequisite.

---

## 7. Licensing & extension-ecosystem considerations

This is where forking quietly hurts and the recommended path stays clean.

**The MIT/proprietary split.** `github.com/microsoft/vscode` (Code-OSS) is MIT. The thing you download as "Visual Studio Code" is a *Microsoft-branded distribution* built from that source with a proprietary `product.json` injected at build time — official logos, telemetry, and the Marketplace endpoint — released under a **Microsoft product licence, not MIT**. So a fork may use the *source* freely but **not** Microsoft's branding, telemetry, or Marketplace. VSCodium exists precisely to build the MIT source *without* those proprietary bits.

**The Marketplace wall.** The Visual Studio Marketplace ToS restricts extension use to **Microsoft products** (VS Code, Visual Studio, Codespaces, Azure DevOps). Using it from a non-Microsoft product — Cursor, Windsurf, VSCodium, Theia, or a PromptConnext fork — **violates those terms**, and Microsoft enforced this in 2025 (the C/C++ extension stopped working in forks). The industry answer, and the one PromptConnext should adopt, is the **Open VSX Registry** (Eclipse Foundation): a vendor-neutral marketplace for exactly these editors. Theia targets Open VSX natively; openvscode-server can be pointed at it.

**Net.** Options B and C sit cleanly on Open VSX with no Microsoft licensing exposure. Option D (fork) drags in branding constraints and the Marketplace prohibition. Option E (extension on users' own VS Code) is fine *on Microsoft's host* but hits the ToS wall the moment you distribute to non-MS hosts. **Recommended posture: build on a VS Code-compatible base, standardize on Open VSX, and where a critical extension is Marketplace-only, either find/point-to an Open VSX equivalent or vendor it.** Flag one dependency risk: Open VSX has smaller coverage and has had availability wobbles historically — worth an explicit "which extensions do our developers actually need, and are they on Open VSX?" audit before committing.

---

## 8. User experience for both personas

The vision — one app, business users and developers side by side — maps naturally onto a VS Code-compatible shell, arguably *better* than onto the current custom webview.

**Business users (Planner Window).** A dedicated activity-bar icon / top-bar entry opens the **Planner** panel: connect-your-LLM, a chat-to-plan conversation, "generate tasks from requirements," and a task view with cloud-sync status. Crucially, business users should see a **curated, de-cluttered layout** — the Planner as the primary surface, editor chrome minimized — because a full IDE is intimidating to a non-technical persona. Theia's customizable layouts (and the ability to hide/rearrange views) make a "business mode" workspace preset realistic; this is genuinely *harder* to fake convincingly in a hand-built shell. Edge cases to design for: a user with no model connected (guided connect flow), offline (the engine's local cache renders the graph), and a business user who never wants to see a file tree at all (layout preset + setting).

**Developers.** They get the thing they actually want: a **real VS Code**, with their keybindings, themes, language servers, debuggers, and Open VSX extensions, plus the integrated terminal where they already run their own agent CLIs (ADR 0009). The same project, the same task graph, the same Git-commit-ref truth-keeping (ADR 0007) — but now inside a first-class editor instead of a Monaco tab. The "Copy context" / BYO-model env handoff moves from a custom pane into a command palette action and a Planner-side button.

**The shared spine.** Both personas operate on one project, one engine, one task graph. The Planner extension and the developer editor are two views over the same local state — which is precisely the "nobody leaves the app between planning and implementation" promise of ADR 0007, now delivered on an editor developers already respect.

---

## 9. Migration path & effort sizing

Effort is expressed in relative T-shirt sizes and rough solo/small-team calendar ranges; treat ranges as planning aids, not commitments. The project has historically been built by a small team (ADR 0001 references a "solo builder"), which is the dominant constraint and the reason the plan front-loads *shippable value with no re-platforming*.

| Workstream | Option A (Tauri upgrade) | Option C (Theia migration) | Option D (fork) |
|---|---|---|---|
| Planner Window UX | S (1–2 wks) | M (2–4 wks as Theia ext) | M |
| Developer IDE fidelity | — (stuck at Monaco) | Built-in (Theia provides) | Built-in (fork provides) |
| Shell re-home (token, keychain, deep-link, updater, engine spawn) | none | **L (4–8 wks)** | L–XL |
| Packaging / CI (macOS arm64 + Windows x64, signing, notarization) | already done | M–L (redo for Electron) | L |
| Extension ecosystem wiring (Open VSX) | n/a | S–M | M |
| Ongoing maintenance | Low | **Low (framework upgrades)** | **High (permanent rebase)** |
| **Rough total to parity** | **S** | **≈ 2–4 months** | **≈ 4–8 months + ongoing team** |

The decisive line is the last one. Options A and C both have *low ongoing* cost; Option D has a *permanent* one. That asymmetry, more than the up-front build, is why the fork is rejected.

**Packaging note (real, from ADR 0001 & DEPLOYMENT).** PromptConnext's packaging is host-platform-bound (it stages the build machine's own Node + `node-pty` prebuild). That constraint *persists* under Electron/Theia and actually gets a little simpler, since Electron bundles Node itself — but the CI matrix (macos-latest arm64 + windows-latest x64), code-signing, and notarization all have to be re-established for the new bundler. Budget for it explicitly; it bit the Tauri build and it will bite the Electron build.

---

## 10. Phased implementation plan (smallest viable milestone first)

Each phase is independently shippable and, per your steer, **each serves both personas**. The re-platform is deliberately *not* first — value ships from day one, and the expensive migration only starts after a spike de-risks it.

**M0 — Decision spike (1–2 weeks, no user-facing change).**
Time-boxed proof: stand up a bare Theia (or openvscode-server) desktop build, spawn the existing engine as a sidecar against it, inject the session token, and open a project folder with the engine's file/terminal routes working. Simultaneously run the **Open VSX extension audit** (§7) and confirm the deep-link + keychain re-home approach. Exit criterion: "engine + VS Code-base + one Planner webview talking to each other on macOS and Windows." This is the true go/no-go gate for the migration; if it's ugly, you fall back to Option A permanently.

**M1 — Planner Window in the *current* Tauri shell (2–3 weeks).**
Ship the "Agent Window from the top bar" now, without any re-platforming. Promote the 3S flow into a named **Planner** surface reachable from `TopBar`, add explicit connect-LLM, generate-tasks, and cloud-sync affordances, and tidy the business/developer split in the existing tabs. Business users get the requested experience immediately; developers keep Monaco + terminal. This banks value even if M0 says "don't migrate."

**M2 — Theia app skeleton with the engine (3–5 weeks).**
Turn the M0 spike into a real, packaged Theia desktop app: engine lifecycle, token, keychain, deep-link, and auto-updater all re-homed; CI/signing/notarization re-established. No Planner yet — the goal is a *distributable shell at parity with the Tauri shell's plumbing*, running a real VS Code-grade editor + terminal for developers.

**M3 — Planner as a first-party Theia extension; unify both personas (3–5 weeks).**
Port the M1 Planner into a Theia extension/widget over the same engine, add the "business mode" layout preset (curated, de-cluttered), and wire the developer command-palette actions (Copy context, point-agent-at-model, task-ref Git truth-keeping). **This is the milestone where the dual-persona VS Code experience is fully realized** — the destination the user described.

**M4 — Cutover & polish (2–4 weeks).**
Migrate remaining users from the Tauri build to Theia, retire the Monaco/xterm custom panes, finalize Open VSX extension recommendations, and document the new shell in the ADR set (a new ADR superseding the shell parts of 0001/0007). Optional: revisit folding the engine into Theia's backend (§6) as a later optimization.

Total: roughly **3–5 months** to the fully unified experience for a small team, with **shippable business-user value at M1 (≈3 weeks in)** and a hard go/no-go gate at M0.

---

## 11. Risks, edge cases & things easy to underestimate

- **Electron weight vs Tauri.** You trade Tauri's small binaries and low memory for Electron's heavier footprint. For a developer IDE this is an accepted industry norm (VS Code itself is Electron), but it *is* a regression from today's lean shell — worth naming to stakeholders.
- **Open VSX coverage & availability.** Some extensions your developers rely on may be Marketplace-only or absent from Open VSX; Open VSX has also had past uptime incidents. Audit early (M0), and be ready to vendor a critical extension.
- **Two-server complexity (esp. Option B).** Running the engine *and* a VS Code server raises the count of moving local processes, ports, and auth surfaces. Theia (single Node backend hosting the IDE, engine as sidecar) is cleaner than openvscode-server-in-Tauri here.
- **Business-user overwhelm.** A full IDE can intimidate non-technical users. The "business mode" layout is not a nice-to-have — it's essential to preserving the current 3S flow's approachability. Prototype it in M0/M3, don't assume it.
- **Security model port.** ADR 0008's origin-allowlist + bearer token and the terminal-WS CSWSH protection must be re-verified on the new shell; a webview-hosted VS Code changes the origin story. Don't treat this as a copy-paste.
- **Code-signing/notarization drift.** Re-established from scratch for the new bundler; historically a source of pain (ADR 0001 lists it as an unresolved caveat even for Tauri).
- **Sunk cost in Monaco/xterm.** M1 deliberately keeps investing in the Tauri shell; some of that is thrown away at M4. This is intentional (value now vs. migration later) but should be a conscious, communicated trade.
- **Don't accidentally rebuild a fork.** If, mid-migration, a "we just need to tweak the editor a little" requirement appears, treat it as a red flag: that is the on-ramp to Option D. Push such needs into the Planner extension or upstream Theia contributions, not shell patches.

---

## 12. Automation & repeatability note

Two parts of this are strong candidates for reuse. The **Open VSX extension audit** (map required extensions → availability) is a repeatable check worth scripting once and re-running each Theia upgrade. And the **M0 spike harness** (engine sidecar + token injection + smoke test against a VS Code base) is exactly the kind of thing to capture as a **Claude Skill** so the same "does the engine boot cleanly against shell X" test can be re-run for Option B vs C comparisons and future upgrades. Worth revisiting your Skills/preferences once the M0 spike shape is known.

---

## 13. Recommendation, restated

Adopt a **VS Code-compatible base rather than a fork**, with **Eclipse Theia (Electron) as the primary target** and **openvscode-server-in-Tauri as the fallback if preserving the Tauri/Rust shell proves to be a hard requirement**. Keep the **Node engine as a sidecar** across the board. Deliver the **Planner Window as a first-party extension**, standardize on **Open VSX**, and **explicitly reject the VS Code hard-fork** (Option D) because its permanent upstream-rebase cost buys editor-internals access the Planner Window does not need. Sequence the work so **business-user value ships in ~3 weeks inside the current Tauri app (M1)**, gated by a **1–2 week de-risking spike (M0)**, with the **unified dual-persona VS Code experience arriving around M3** and full cutover by M4 — roughly a 3–5 month arc for a small team, with a real off-ramp back to "stay on Tauri" if the spike disappoints.

---

## Sources

- [Is Cursor AI a VS Code Fork? Everything Explained — lowcode.agency](https://www.lowcode.agency/blog/is-cursor-ai-vs-code-fork)
- [How Cursor Actually Works: Architecture and Engineering — Data Science Collective / Medium](https://medium.com/data-science-collective/how-cursor-actually-works-c0702d5d91a9)
- [Cursor Deep Dive: $29B by Forking VS Code — MMNTM](https://www.mmntm.net/articles/cursor-deep-dive)
- [Why Cursor, Windsurf and co fork VS Code, but shouldn't — Eclipse Foundation Blog](https://blogs.eclipse.org/post/thomas-froment/why-cursor-windsurf-and-co-fork-vs-code-shouldnt)
- [VS Code forks: Cursor, Kiro, Antigravity, and more — vgtc.io](https://www.vgtc.io/insights/vs-code-forks-ide-landscape-2026-h1)
- [The VS Code Fork Dilemma: Innovation at the Cost of Fragmentation? — Pullflow](https://www.pullflow.com/blog/cursor-vs-code-fragmentation/)
- [Eclipse Theia IDE vs VS Code — Markaicode](https://markaicode.com/vs/eclipse-theia-ide-vs-vs-code-self-hosted-development-environment-comparison/)
- [Theia vs OpenVSCode Server — StackShare](https://stackshare.io/stackups/openvscode-server-vs-theia)
- [Eclipse Foundation Releases Open-Source Theia IDE — Compatible with VS Code Extensions — Slashdot](https://developers.slashdot.org/story/24/07/06/0422230/eclipse-foundation-releases-open-source-theia-ide---compatible-with-vs-code-extensions)
- [Eclipse Open VSX: A Free Marketplace for VS Code Extensions — Eclipse Foundation](https://newsroom.eclipse.org/news/community-news/eclipse-open-vsx-free-marketplace-vs-code-extensions)
- [Eclipse Foundation offers enterprise-grade open source alternative to Microsoft's VS Code Marketplace — The New Stack](https://thenewstack.io/open-vsx-managed-registry/)
- [VSCodium — VS Code sans Microsoft branding/telemetry/licensing — Changelog](https://changelog.com/news/vscodium-vs-code-sans-microsoft-brandingtelemetrylicensing-A03j)
- [VSCodium — Open Source Binaries of VSCode](https://vscodium.com/)
- [Visual Studio Code May Not Be As Open Source As You Think — Keyboard Playing](https://keyboardplaying.org/blog/2022/01/visual-studio-code-not-open-source/)
- [Chat Participant API — Visual Studio Code Extension API](https://code.visualstudio.com/api/extension-guides/ai/chat)
- [Language Model API — Visual Studio Code Extension API](https://code.visualstudio.com/api/extension-guides/ai/language-model)
- [Expanding Model Choice in VS Code with Bring Your Own Key — VS Code Blog](https://code.visualstudio.com/blogs/2025/10/22/bring-your-own-key)
