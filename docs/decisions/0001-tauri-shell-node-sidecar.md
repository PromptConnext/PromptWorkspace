# ADR 0001 — Tauri 2 shell, Node sidecar engine

**Date:** 2026-07-03 · **Status:** Accepted (skeleton) · Resolves architecture §5 open decisions #1–2.

## Decision
- Desktop shell: **Tauri 2** with a React/Vite webview. Compiles and packages cleanly on macOS; OS keychain reachable; small binaries.
- Local engine: **Node/TypeScript sidecar** (Hono + `node:sqlite`), spawned by the shell at startup on `127.0.0.1:47131`. Node 24 runs TS natively — no build step. One language across UI and engine beats FastAPI reuse for a solo builder; no Ideva Kit code was actually needed.
- No embedded editor, ever (roadmap risk #3): PromptZone is an orchestrator; developers keep their IDE.

## Sidecar lifecycle
The shell passes `PROMPTZONE_PARENT_PID`; the engine watches `process.ppid` and exits when reparented, so it dies with the shell even on SIGKILL. The shell also kills the child on clean exit.

## Caveats (must fix before distribution)
- Engine path resolves from `PROMPTZONE_ENGINE_DIR` or the compile-time repo path — a packaged app must bundle the engine as a resource.
- `node` is expected on PATH; a distribution must bundle a runtime (or compile the engine to a single binary).
- Keychain access shells out to macOS `security`; swap for a cross-platform keyring binding for Windows/Linux.
