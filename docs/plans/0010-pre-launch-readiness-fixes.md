# Plan 0010 — Pre-launch readiness fixes

**Date:** 2026-07-25 · **Status:** Shipped · **Review:** [Pre-launch readiness review](../reports/2026-07-25-pre-launch-readiness-review.md)

This plan implements the Must Have and Should Have fixes from the 2026-07-25 pre-launch readiness review. Explicitly out of scope, left to the user: the `CLOUD_WEB_URL` shared-Vercel-subdomain risk and macOS code-signing/notarization. Test coverage work is targeted smoke coverage on the highest-risk modules, not full parity — apps/desktop and apps/corp intentionally have no test framework added in this pass.

Absolute paths below are relative to the repo root `/Users/kittisak/REPO/ideva/PromptZone`.

---

## M1 — Cloud startup guards (stub-auth block + CORS warning)

`apps/cloud/app/config.py`: `Settings.require_production_safety() -> list[str]` raises `RuntimeError` when `app_env == "production"` and `auth_mode == "stub"` (full auth-bypass risk); returns non-fatal warning strings when `app_env == "production"` and `cors_origin_list` is still just the localhost dev defaults. Wired into `apps/cloud/app/main.py`'s startup path alongside `require_supabase()`/`require_auth()`.

New `apps/cloud/tests/test_startup_guards.py`. **Verified:** `ruff check` clean; `pytest tests/test_startup_guards.py -v` 5/5; full suite 165/165.

## M2 — Sync conflict visibility (silent data loss fix)

Threaded a `conflicts: dict[str, list[str]]` signal through 5 layers:

- `apps/cloud/app/db/merge.py`'s `merge_entity()` now returns `(merged, dropped_fields)` instead of a bare dict.
- Both repository backends (`apps/cloud/app/db/repository.py` in-memory, `apps/cloud/app/db/supabase_repository.py`) accumulate `conflicts` alongside the existing `upserted` counts.
- `apps/cloud/app/models/schemas.py`'s `GraphUpsertResponse` gets an additive `conflicts` field; `apps/cloud/app/api/sync.py` passes it through.
- `apps/engine/src/sync/loop.ts`'s `SyncResult` type carries `conflicts?`; `apps/engine/src/routes/cloud.ts` needed no change (already proxies verbatim).
- `apps/desktop/src/api.ts`'s `CloudSyncResult` gets `conflicts?`; `apps/desktop/src/components/CloudConnect.tsx` renders an expandable warning banner when non-empty.

**Verified:** cloud `test_merge.py`/`test_sync.py` extended, full suite 171/171; engine `node --test` all pass; desktop `tsc`/`pnpm build` clean.

## M3 — Structured logging + error boundaries

- New `apps/engine/src/logger.ts` — dependency-free leveled logger (`log.info/warn/error`, JSON lines, `PROMPTCONNEXT_LOG_LEVEL` env var), replacing the engine's 2 `console.log` call sites.
- `apps/cloud/app/main.py` — added a format string to `logging.basicConfig` for parseable output.
- New `apps/desktop/src/ErrorBoundary.tsx`, wired around `<App />` in `main.tsx`.
- New `apps/web/src/app/error.tsx` + `global-error.tsx` (Next.js App Router convention).

**Verified:** engine `node --test` (new `logger.test.ts` included) all pass; cloud full suite 166/166; desktop `pnpm build` clean; web `pnpm typecheck` clean.

## M4 — apps/engine smoke tests

New test files, `node:test` + `node:assert/strict`, no mocking library, following `apps/engine/test/g2-roster.test.ts`'s established pattern:

- `security.test.ts` + `security-with-token.test.ts` — origin allowlist, bearer/query-token auth.
- `keychain.test.ts` — real OS keychain round-trip, gated behind `PROMPTCONNEXT_TEST_KEYCHAIN=1` (opt-in; a sandboxed/headless session has no unlocked login keychain, so the real `security` CLI otherwise falls back to a blocking native dialog instead of failing cleanly). Skips on Linux (no libsecret implementation).
- `anthropic-compat.test.ts` — protocol translation round-trip against a fake upstream.
- `agent-runner.test.ts` — `anyAgentAvailable()` no-throw check; error-path coverage via the `PROMPTCONNEXT_AGENT_CMD` custom-adapter escape hatch (deterministic `agent-crash`/`no-changes`/`no-agent` cases without needing a real installed CLI).

**Verified:** `node --test test/*.test.ts` green (documented gap: the agent-runner success path needs a real installed CLI, not exercised here — see the review's "known coverage gaps" section).

## M5 — apps/web test framework + auth smoke tests

Wired up vitest + `@testing-library/react` + `happy-dom` (new `apps/web/vitest.config.ts`, `package.json` `test` script). New `apps/web/src/lib/auth.test.tsx` (stub-mode `AuthProvider`/`useAuth()`) and `apps/web/src/app/(auth)/login/page.test.tsx` (stub-mode login submit + `safeNext()` open-redirect-guard unit tests, exported for direct testing).

**Verified:** `pnpm test` 8/8 pass; `pnpm typecheck` clean.

## M6 — BYO-agent CLI install links

`AgentInfo.installUrl?: string` populated server-side (`apps/engine/src/routes/agents.ts`) per adapter id. `AgentPicker.tsx`'s not-installed chips now render as real clickable links via the app's existing `@tauri-apps/plugin-opener` mechanism. Same fix applied to `ConnectForm.tsx`'s previously-inert `getKeyUrl` text.

**Verified:** desktop/engine typecheck clean; manual trace confirms real `<a>` elements with `openUrl()` wiring.

## M7 — Should-have batch

- **7a. Presence WS auth unification** — `apps/cloud/app/api/presence.py` now reuses the shared `_verify_jwt` (JWKS/ES256-first, HS256-fallback) instead of its own HS256-only decode. New from-scratch ES256/JWKS test fixture (none existed in the suite before). Full cloud suite 166/166.
- **7b. Unsaved-changes close guard** — `apps/desktop/src/components/EditorPane.tsx`'s `close()` gates on `tab.dirty` and confirms via `@tauri-apps/plugin-dialog`'s `ask()`. Desktop build clean.
- **7c. Engine crash retry** — Rust-side (`apps/desktop/src-tauri/src/lib.rs`) ring buffer captures engine stdout/stderr; new `engine_log_tail`/`restart_engine` Tauri commands reuse the existing spawn logic and preserve the session token across a crash-restart (no webview reload needed). `App.tsx` adds a Retry button + collapsible log view. `cargo check` and `pnpm build` both clean.
- **7d. RAG budget soft-degrade** — `apps/cloud/app/api/assistant.py` now always runs the zero-cost lineage-facts graph-walk before checking budget; on exhaustion, degrades to facts-only with a clear SSE message instead of a hard 429, unless there are no facts either (still 429s in that case). Cloud suite 171/171.
- **7e. Structured error kinds** — new `apps/engine/src/agent/errors.ts` (`AgentError`/`AgentErrorKind`: `no-agent`/`agent-crash`/`no-changes`/`bad-output`/`network`), threaded through the SSE error boundary, `apps/desktop/src/api.ts`, and `ThreeS.tsx`'s error UI (kind-specific guidance, working Retry for network errors). Engine tests 34/1-skip; desktop build clean; cloud untouched, 171/171.
- **7f. Connection management (disconnect) UI** — new `DELETE /engine/models/:id` (clears rather than hard-deletes, given the confirmed `agent_runs.model_connection_id` FK), `deleteModelConnection()` client helper, new `ConnectedModels.tsx` list-and-disconnect component mounted in the Skill panel. Engine tests 34/4-skip (keychain-secret assertions opt-in per M4); desktop build clean; cloud untouched, 171/171.
- **7g. CORS production check** — covered by M1, no separate work.

## Explicitly deferred (user-owned)

- `CLOUD_WEB_URL` shared-Vercel-subdomain takeover risk.
- macOS code-signing/notarization.
