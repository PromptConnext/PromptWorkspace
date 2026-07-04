# ADR 0008 — Localhost origin allowlist (CSWSH/CSRF defense)

**Date:** 2026-07-04 · **Status:** Accepted. Prompted by a security review of the integrated terminal (ADR 0007).

## Threat
The engine binds `127.0.0.1`, but every web page the user's browser loads can still send requests to it. WebSockets have no CORS preflight, so a drive-by page could open `ws://127.0.0.1:<port>/engine/projects/:id/terminal` and receive a live shell in the project directory — **Cross-Site WebSocket Hijacking → RCE.** The wide-open `cors()` also let any origin read HTTP responses.

## Decision
An origin allowlist (`src/security.ts`): `tauri://localhost`, `https://tauri.localhost` (Windows), `http://localhost:1420` / `127.0.0.1:1420` (vite dev), extensible via `PROMPTZONE_ALLOWED_ORIGINS`.
- **Terminal WS:** the upgrade reads `Origin` (browsers always send it and cannot forge it) and closes with 1008 before spawning any shell if it isn't allowlisted.
- **HTTP:** `cors()` reflects only allowlisted origins instead of `*`.

Native clients (curl, the spawned agent hitting `/anthropic`) send no browser `Origin`; CORS governs only browsers, so they are unaffected.

## Why this is sufficient for the browser threat, and what's deferred
Browsers set an accurate `Origin` on both fetch and WS handshakes and scripts cannot override it, so the allowlist fully blocks the drive-by/other-localhost-app-XSS vector — the realistic CSWSH exploit. A non-browser local process can forge `Origin`, but such a process already has code execution and doesn't need our shell, so it's outside this threat model.

**Deferred to distribution hardening (with ADR 0001):** a per-session bearer token minted at engine startup and handed to the webview by the Tauri shell, required on every request. That adds defense against same-origin XSS in our own app and is the standard local-app pattern (Jupyter-style). It needs token plumbing through the Rust shell and dev mode, so it is sequenced with the packaging work rather than half-built now. Verified: evil origin → WS closed 1008, no shell; allowed origin → shell works; evil HTTP origin → not reflected; no-origin native client → served.
