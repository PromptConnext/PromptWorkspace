# Pre-launch readiness review — 2026-07-25

**Date:** 2026-07-25 · **Status:** Findings addressed (see [Plan 0010](../plans/0010-pre-launch-readiness-fixes.md) for what shipped) · **Reviewers:** three parallel agent audits (desktop, cloud/web, cross-cutting reliability/security) plus targeted follow-up exploration

This is a point-in-time Product Owner readiness audit of PromptConnext ahead of launch, covering the desktop app (`apps/desktop` + `apps/engine`), the cloud collaboration product (`apps/cloud` + `apps/web`), and cross-cutting reliability/security/observability concerns. It is written from a real-customer-adoption-risk perspective, not a pure code-quality pass.

Findings are grouped Must Have / Should Have / Nice to Have. Each item cites the code/doc that grounded it at review time and links to the fix (or states why it's deferred). See [Plan 0010](../plans/0010-pre-launch-readiness-fixes.md) for full implementation detail on everything marked shipped.

## Must Have

1. **`CLOUD_WEB_URL` points at a shared Vercel subdomain** — dangling-subdomain-takeover risk if the Vercel project is ever deleted/renamed (`apps/engine/src/config.ts`). Flagged in ADR 0014 follow-ups as fine pre-installer, hard blocker before public distribution. **Deferred — user-owned**, needs a move to an org-owned custom domain.
2. **No DB backup/export path.** The engine's `node:sqlite` file is the sole source of truth for offline users (cloud sync is opt-in per ADR 0010); a disk failure loses the whole task graph with no recovery story. **Shipped** — WP2 doesn't add a backup mechanism directly, but the sync-conflict visibility work (below) at least makes data loss from concurrent edits visible; standalone local export/backup tooling remains a good follow-up beyond this pass's scope.
3. **No error tracking/telemetry anywhere** — 2 `console.log` calls total in `apps/engine`, stdout-only logging in `apps/cloud`, nothing in `apps/web`/`apps/desktop`/`apps/corp`. **Shipped** (WP3): a dependency-free structured logger for the engine (`apps/engine/src/logger.ts`), a parseable log format for cloud, and React/Next.js error boundaries for desktop (`apps/desktop/src/ErrorBoundary.tsx`) and web (`apps/web/src/app/error.tsx` + `global-error.tsx`) — self-contained, no hosted SaaS dependency, ready for a future Sentry/PostHog tap.
4. **macOS build unsigned/non-notarized** (`docs/DEPLOYMENT.md` §3.1). **Deferred — user-owned.**
5. **Stub auth mode has no runtime guard against prod deploy** — `AUTH_MODE=stub` + `X-User-Id` header lets anyone act as anyone, with nothing stopping an accidental production deploy in that mode. **Shipped** (WP1): `apps/cloud/app/config.py`'s `require_production_safety()` hard-refuses to boot when `app_env == "production"` and `auth_mode == "stub"`.
6. **apps/engine near-zero test coverage** (1 test file / 24 source files pre-review); apps/web/apps/desktop/apps/corp had zero. **Shipped, targeted smoke coverage** (WP4, WP5): new engine tests for `security.ts`, `keychain.ts`, `gateway/anthropic-compat.ts`, `agent/agent-runner.ts`; a vitest framework stood up for apps/web with stub-mode auth-flow smoke tests. apps/desktop and apps/corp intentionally still have no framework — explicit scope decision, not an oversight.
7. **Sync conflict handling is silent data loss** — field-level last-write-wins merge (`apps/cloud/app/db/merge.py`) silently dropped losing writes with zero signal. **Shipped** (WP2): `merge_entity()` now returns dropped-field info, threaded through the cloud API response, engine sync loop, and into a desktop warning banner ("N of your edits were overwritten by newer changes from a teammate").
8. **BYO-agent CLI setup gap** — a business user only discovers "you need Claude Code/Codex/Gemini CLI installed" two steps into the planning flow, with no install links (asymmetric vs. the well-guided API-key path). **Shipped** (WP6): `AgentPicker.tsx` not-installed chips are now real clickable install-docs links; fixed the same latent bug in `ConnectForm.tsx`'s `getKeyUrl` (was inert text, now a real link) while in the area.

## Should Have

- **Presence WS auth inconsistency** — HS256-only JWT verification in `apps/cloud/app/api/presence.py`, inconsistent with the REST path's JWKS/ES256-first `_verify_jwt`. **Shipped** (WP7a): unified onto the shared verification function; added the JWKS/ES256 test fixture from scratch since none existed anywhere in the suite.
- **Editor silently discards unsaved changes on tab close** — `EditorPane.tsx`'s `close()` had no dirty-check. **Shipped** (WP7b): now gates on `tab.dirty` and confirms via the already-installed `@tauri-apps/plugin-dialog`'s `ask()`.
- **Engine sidecar crash recovery UX** — only recourse was "check the logs and relaunch," no in-app visibility or retry. **Shipped** (WP7c): Rust-side ring buffer captures engine stdout/stderr, new `engine_log_tail`/`restart_engine` Tauri commands, a Retry button + collapsible recent-log view in the desktop error state.
- **RAG assistant hard-fails on budget exhaustion** — a hard 429 with no soft-degrade. **Shipped** (WP7d): the zero-cost lineage-facts graph-walk now always runs first; on budget exhaustion, falls back to facts-only with a clear message instead of erroring, but still 429s when there's nothing to answer with at all.
- **Generic error banners, no kind/retry differentiation** — all agent/loop errors were plain `Error` strings with no machine-readable kind. **Shipped** (WP7e): new `AgentError`/`AgentErrorKind` in the engine, threaded through to the desktop client and `ThreeS.tsx`'s error UI for kind-specific guidance (e.g. a working Retry button for network-kind failures).
- **No key-rotation/revoke UI** — reconnecting silently superseded old credentials, but there was no visible connections list or explicit disconnect. **Shipped** (WP7f): new `DELETE /engine/models/:id` route (clears rather than hard-deletes, given the FK from `agent_runs`) plus a `ConnectedModels` list-and-disconnect component.
- **CORS_ORIGINS misconfig has no deploy-time enforcement.** **Shipped** as part of WP1's `require_production_safety()` — warns (doesn't crash) if a production deploy still has only localhost origins configured.

## Nice to Have (not in this pass)

- No resend/reminder for pending workspace invitations.
- Presence connection cap (50/project) has no operator-facing alert before hitting the ceiling.
- Linux keychain unimplemented and undocumented as unsupported.
- No billing/plans, admin/audit log, data export, or notification digests — expected-absent for an MVP, called out here so it's a deliberate decision, not a silent gap.
- OCR ingestion (`apps/cloud/app/documents/ocr.py`) is a placeholder stub pending the managed Typhoon-OCR source.
- Discussions are flat (no threading/@mentions/reactions) — functional for v1, thin next to Notion/Linear-grade collaboration tools.

## Known coverage gaps left by the smoke-test pass

- `agent-runner.ts`'s success path (a real agent CLI actually completing a task) isn't exercised in CI-portable tests — it requires an installed CLI on PATH, which isn't guaranteed across environments. The new tests cover the error paths (`no-agent`, `agent-crash`, `no-changes`) deterministically via the `PROMPTCONNEXT_AGENT_CMD` custom-adapter escape hatch instead.
- The new `apps/engine/test/keychain.test.ts` and `models-disconnect.test.ts` keychain-secret-deletion assertions are gated behind `PROMPTCONNEXT_TEST_KEYCHAIN=1` — a sandboxed/headless session has no unlocked login keychain, so the real `security` CLI falls back to a blocking native "Keychain Not Found" dialog instead of failing cleanly. Run with that env var set on a machine with a real, unlocked keychain to exercise the live path.
