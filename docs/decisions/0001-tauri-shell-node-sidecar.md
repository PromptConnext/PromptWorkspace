# ADR 0001 — Tauri 2 shell, Node sidecar engine

**Date:** 2026-07-03 · **Status:** Accepted (skeleton) · Resolves architecture §5 open decisions #1–2.

## Decision
- Desktop shell: **Tauri 2** with a React/Vite webview. Compiles and packages cleanly on macOS; OS keychain reachable; small binaries.
- Local engine: **Node/TypeScript sidecar** (Hono + `node:sqlite`), spawned by the shell at startup on `127.0.0.1:47131`. Node 24 runs TS natively — no build step. One language across UI and engine beats FastAPI reuse for a solo builder; no Ideva Kit code was actually needed.
- No embedded editor, ever (roadmap risk #3): PromptZone is an orchestrator; developers keep their IDE.

## Sidecar lifecycle
The shell passes `PROMPTZONE_PARENT_PID`; the engine watches `process.ppid` and exits when reparented, so it dies with the shell even on SIGKILL. The shell also kills the child on clean exit.

## Packaging progress (2026-07-05)
- **Engine bundled + resolved from the app (done).** `beforeBuildCommand` runs `pnpm stage:engine`, a **hoisted** `pnpm deploy` (`--config.node-linker=hoisted`) that produces a symlink-free, self-contained engine at `src-tauri/.engine-pkg` (raw pnpm `node_modules` is a symlink forest into the monorepo store and can't be bundled; `cp -RL` breaks Node ESM resolution — hoisted deploy is the working recipe). It's declared as a bundle resource (`.engine-pkg → engine`) and the Rust shell resolves the engine from `resource_dir()/engine` when present, falling back to the repo path in dev. **Verified:** a `.app` copied *outside* the repo starts the engine from `…/PromptZone.app/Contents/Resources/engine` (log confirms the path), node-pty's `darwin-arm64` prebuild + `spawn-helper` are present, health 200, token-protected, dies with the app.
- **Per-session auth token (done)** — see ADR 0008.

## Remaining caveats (before external distribution)
- `node` is still expected on PATH; a distribution must bundle a Node runtime (e.g. a Tauri sidecar binary) or compile the engine — the ABI-sensitive step, given node-pty is a native addon and `node:sqlite` needs Node ≥24. **This is the next packaging task.**
- The bundled engine carries node-pty prebuilds for all platforms (~62 MB of 66 MB); prune to the target platform to shrink the bundle.
- Keychain access shells out to macOS `security`; swap for a cross-platform keyring binding for Windows/Linux.
