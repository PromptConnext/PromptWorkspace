# ADR 0008 — Localhost origin allowlist (CSWSH/CSRF defense)

**Date:** 2026-07-04 · **Status:** Accepted. Prompted by a security review of the integrated terminal (ADR 0007).

## Threat
The engine binds `127.0.0.1`, but every web page the user's browser loads can still send requests to it. WebSockets have no CORS preflight, so a drive-by page could open `ws://127.0.0.1:<port>/engine/projects/:id/terminal` and receive a live shell in the project directory — **Cross-Site WebSocket Hijacking → RCE.** The wide-open `cors()` also let any origin read HTTP responses.

## Decision
An origin allowlist (`src/security.ts`): `tauri://localhost`, `https://tauri.localhost` (Windows), `http://localhost:1420` / `127.0.0.1:1420` (vite dev), extensible via `PROMPTCONNEXT_ALLOWED_ORIGINS`.
- **Terminal WS:** the upgrade reads `Origin` (browsers always send it and cannot forge it) and closes with 1008 before spawning any shell if it isn't allowlisted.
- **HTTP:** `cors()` reflects only allowlisted origins instead of `*`.

Native clients (curl, the spawned agent hitting `/anthropic`) send no browser `Origin`; CORS governs only browsers, so they are unaffected.

## Why this is sufficient for the browser threat, and what's deferred
Browsers set an accurate `Origin` on both fetch and WS handshakes and scripts cannot override it, so the allowlist fully blocks the drive-by/other-localhost-app-XSS vector — the realistic CSWSH exploit. A non-browser local process can forge `Origin`, but such a process already has code execution and doesn't need our shell, so it's outside this threat model.

**Per-session bearer token — implemented (2026-07-05, packaging pass).** The Tauri shell mints a 128-bit token from `/dev/urandom` at launch, passes it to the engine via `PROMPTCONNEXT_AUTH_TOKEN`, and injects it into the webview as `window.__PROMPTCONNEXT_TOKEN__` via an `initialization_script` on a Rust-built window (config window removed to allow the script). When the token is set, the engine requires it on every request (`Authorization: Bearer` for HTTP, `?token=` for the terminal WS, since browsers can't set WS headers); the health probe stays open for liveness, and dev (`pnpm engine`, no token env) enforces nothing so browser testing still works. The Claude Code adapter sends the token as `ANTHROPIC_API_KEY` so its façade calls authenticate. This closes the same-origin-XSS / non-browser-local-process gap the origin allowlist alone couldn't.

Verified: evil origin → WS closed 1008; allowed origin → shell works; evil HTTP origin → not reflected; no-origin native client → served. Token: health 200 without token; `/agents` 401 without / 401 wrong / 200 correct; WS 401 without token, passes auth with `?token=`; the packaged shell's engine is 401 without a token (proving the mint→env handoff). Pending: visual confirmation the packaged webview authenticates end-to-end (needs a full `tauri build`).
