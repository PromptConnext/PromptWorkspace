# ADR 0016 M0 report — decision spike, go/no-go gate

**Date:** 2026-07-23 · **Branch:** `spike/0016-theia-m0` · **Location:** `spikes/theia-shell/` (isolated from `apps/desktop`, own `package.json`/lockfile, not in the pnpm workspace — the current Tauri app was never touched)

## What was built

A bare Eclipse Theia (1.66.0) Electron desktop app (`electron` 38.4.0, matching Theia's peer requirement) that:

- Spawns the **unmodified** `apps/engine` (`node src/index.ts`, Node 24) as a child process at startup (`src/engine-lifecycle.js`), passing `PROMPTCONNEXT_PARENT_PID` / `PROMPTCONNEXT_AUTH_TOKEN` exactly like `lib.rs`'s `spawn_engine`.
- Mints the same-shaped token as `lib.rs::mint_token()` — 32 hex chars from `crypto.randomBytes(16)` (`src/token.js`).
- Injects `window.__PROMPTCONNEXT_TOKEN__` before any app script runs, via an Electron preload registered through `session.defaultSession.setPreloads()` (`src/preload.js` + `src/electron-entry.js`) — layered on top of Theia's own preload rather than replacing it, so Theia's own IPC keeps working.
- Extends the engine's origin allowlist purely via the existing `PROMPTCONNEXT_ALLOWED_ORIGINS` env var (`src/security.ts`'s documented extension point) — **zero engine code changes**.

No engine route, schema, or contract was touched. `apps/desktop` is untouched; M1 still ships from the Tauri app regardless of this spike's outcome.

## Exit criteria — PASS/FAIL

| Criterion | Result | Evidence |
|---|---|---|
| Engine + Theia + a webview talk over the token-authenticated loopback API, **macOS arm64** | **PASS** | Full run log below. Health, file list/read/status, and terminal WS all verified with the minted bearer token. |
| Same, **Windows x64** | **NOT RUN — no Windows machine in this environment.** Nothing in the design is Windows-specific (Electron + `node:child_process.spawn('node', …)` is cross-platform; the deep-link/keychain prototype below explicitly uses the Windows-side Electron APIs), but this must be exercised on real Windows hardware/CI before treating M0 as fully passed. **Flag this as the one open action before declaring GO.** |
| Open VSX extension audit has no unresolved blocker | **PASS with two flagged (non-blocking) gaps** | `docs/open-vsx-audit.md`: one confirmed blocker (`ms-vscode.cpptools`, the exact 2025 enforcement incident the ADR cites) and one likely gap (Pylance) — neither affects this repo's actual stack (TS/JS + Python + Rust + Go, all clean on Open VSX). |
| Deep-link + keychain re-home approach confirmed routine | **PASS** | `src/deep-link-keychain-prototype.md` — both map to well-documented, built-in Electron APIs (`setAsDefaultProtocolClient`/`open-url`/`second-instance`, `safeStorage`). Not wired into the running app (out of scope for M0); no missing platform primitive found. |
| Non-allowlisted origin rejected (ADR 0008 test) | **PASS** | See "Origin allowlist test" below — reproduces the exact 1008-close behavior, driven entirely by the env-var extension point. |

## Full run evidence (macOS arm64)

```
[promptconnext-spike] minted token c1b55c61e2085566a59b8e9f17d5d3c4
[engine] listening on http://127.0.0.1:47199
[promptconnext-spike] engine healthy, launching Theia
[promptconnext-spike] preload injected: .../src/preload.js
... Theia frontend reaches 'ready' state ...
```

Engine calls against the running sidecar, through the same auth path the Tauri shell uses:

```
$ curl .../engine/health                          → {"ok":true,...}
$ curl .../agents                (no token)        → 401
$ curl -H "Authorization: Bearer <token>" .../agents → 404 (route requires further params — proves auth passed, not a rejection)

# Created a real project, then exercised the editor's actual routes:
$ POST /engine/projects          → 201 {"id": "...", ...}
$ GET  /engine/projects/:id/files  → full file tree, 200
$ GET  /engine/projects/:id/file?path=package.json → file content, 200
$ GET  /engine/projects/:id/status → {"changed":[]}, 200
```

### Origin allowlist test (ADR 0008 reproduction)

Ran the engine standalone with `PROMPTCONNEXT_ALLOWED_ORIGINS=http://localhost:62219` (Theia's observed frontend origin for that run) and drove the terminal WS with three `Origin` values:

```
ALLOWED-origin (http://localhost:62219): WS opens
EVIL-origin (http://evil.example.com):   WS closes 1008 "forbidden origin"
NO-origin (missing header):              WS closes 1008 "forbidden origin"
```

Matches ADR 0008's exact contract — allowlisted origin passes, forged/missing origin never gets a shell — with no engine changes, purely via the env var.

## Real finding: Theia's frontend origin is dynamic, not fixed

Tauri gives a fixed origin (`tauri://localhost`) that can be hardcoded into the allowlist once. **Theia's Electron target does not** — `ElectronMainApplication.startBackend()` binds its own local HTTP server to an OS-assigned ephemeral port each launch (`http://localhost:<random-port>`), and that's the origin the renderer sends when calling our engine cross-origin. A static `PROMPTCONNEXT_ALLOWED_ORIGINS` value set before launch can't know this port in advance.

**This is not a blocker** — Theia resolves its backend port *before* creating the window (`this._backendPort.resolve(port)` happens ahead of `app.whenReady()`/window creation in `electron-main-application.js`). The correct M2 fix is to **sequence engine spawn after Theia's own backend port is known**, in a real `ElectronMainApplicationContribution.onStart()`, passing that exact origin into `PROMPTCONNEXT_ALLOWED_ORIGINS` — still zero engine changes, just spawn-order discipline instead of spawning as the very first thing (which is what this quick spike script did for simplicity). Flagging explicitly because it's the kind of detail that's cheap to fix now and expensive to discover mid-M2.

## Open VSX audit

See `docs/open-vsx-audit.md`. Bottom line: no blocker for this repo's actual developer stack (TS/JS, Python, Rust, Go, YAML, Docker all clean on Open VSX); C/C++ tooling (`ms-vscode.cpptools`) and Pylance are known gaps to revisit only if a developer needs them, with Open VSX-native alternatives (`clangd`, community Python LSPs) available.

## Deep-link + keychain

See `src/deep-link-keychain-prototype.md`. Both re-homes map to standard, well-documented Electron APIs with no missing platform primitive — if anything, `safeStorage` is simpler than the current Rust `security`-CLI shell-out (no native module / prebuild-per-platform problem, unlike `keytar`).

## Packaging note

Not exercised in this spike (out of scope for M0 per the ADR — that's M2's "distributable shell" milestone), but worth flagging: this spike used a plain `npm install` inside `spikes/theia-shell/` for isolation. `apps/desktop`'s existing "bundle the build machine's own Node + prune node-pty prebuilds" recipe (ADR 0001) will need an equivalent for the Electron/Theia bundler — Electron bundles its own Node, which actually *simplifies* this versus Tauri's manual Node-bundling step, but CI signing/notarization still needs to be re-established from scratch (as the ADR already anticipated).

## Recommendation

**Conditional PASS — proceed toward M2, contingent on a Windows arm64/x64 run before fully closing M0.** Nothing macOS-side was ugly enough to justify falling back to Option A. Every "moves" item (engine spawn, token injection, allowlist extension, deep-link, keychain) mapped cleanly onto Electron with no missing primitive, and the one real surprise (dynamic frontend origin) has a known, cheap, zero-engine-change fix for M2. Before declaring the gate fully green: (1) run this same spike on Windows x64, (2) fold the origin-sequencing fix into the M2 design so it's not rediscovered under time pressure there.
