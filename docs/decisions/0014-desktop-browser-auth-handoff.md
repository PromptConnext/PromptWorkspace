# ADR 0014 — Desktop signs in through the hosted web auth pages, not a native form

**Date:** 2026-07-17 · **Status:** Accepted. Extends ADR 0008 (local session token) and the cloud-identity path in ADR 0010; supersedes the native email/password login in `CloudConnect`. Prompted by the question: *do we redesign desktop's auth screens, or send the desktop to the web login and redirect back with a token?*

## Decision
The desktop app authenticates to PromptConnext Cloud by opening the **hosted web auth pages** (`apps/web`) in the user's system browser and receiving the session back through a `promptconnext://` deep link. The native email/password form in `CloudConnect` is **removed** — browser login becomes the single path.

The deciding constraint is that **OAuth / social login, magic-link, and MFA are on the roadmap**, and the desktop's current mechanism cannot reach them: it posts email+password straight to Supabase's password-grant endpoint (`supabasePasswordLogin`, `cloudClient.ts`). A password grant can never do a Google sign-in or an MFA challenge. Those flows only exist in a real browser context, so the browser is where login must happen. Sending the desktop to the same `apps/web` pages also means **one auth UI** — register, forgot-password, and reset-password come for free instead of being rebuilt natively.

## Why a one-time code, not a token in the URL
Supabase's PKCE `code_verifier` lives in the browser (supabase-js), so the engine cannot perform the final code exchange itself — the browser must complete auth and hand the *result* to the desktop. The naive handoff redirects to `promptconnext://…#refresh_token=…`, but any local app that registers the same URL scheme could intercept that long-lived token.

Instead the browser brokers the session through the cloud as a **short-lived, single-use opaque code**:

1. The engine generates a random `state`, opens the browser to `${CLOUD_WEB_URL}/login?desktop=1&state=<state>`.
2. The user signs in on the web — by any method Supabase supports.
3. The web page posts its session to the cloud (`POST /desktop-auth/handoff`, Bearer + refresh token + `state`); the cloud stores the session against a freshly minted `handoff_code` with a short TTL.
4. The web redirects to `promptconnext://auth/callback?code=<handoff_code>&state=<state>`.
5. The desktop deep-link handler verifies `state`, passes `code` to the engine, which calls `POST /desktop-auth/redeem`; the cloud returns the tokens and deletes the code. The engine stores them in the OS keychain — the same `cloud.session` slot used today.

Only the opaque code rides the deep link, and it is worthless after one use or after its TTL. Long-lived tokens never appear in a URL. The `state` check ties the callback to the request the desktop actually started, closing the door on injected callbacks.

## Consequences
- **One auth surface.** Login/register/forgot/reset live only in `apps/web`; the desktop keeps no auth screens beyond a "Sign in with browser" button and the deep-link plumbing. No two-UI drift.
- **OAuth-ready.** Whatever `apps/web` + Supabase gain (Google, GitHub, magic-link, MFA) the desktop inherits with no further work.
- **New moving parts.** `tauri-plugin-deep-link` and per-OS registration of the `promptconnext://` scheme; two new cloud endpoints and a short-TTL code store (in-memory is fine — the cloud already runs single-instance, ADR 0011); a browser round-trip on every fresh login (acceptable — sessions are long-lived and refreshed, so this is rare).
- **Storage unchanged downstream.** Redeemed tokens land in the keychain via the existing path; `cloudClient.ts::authHeaders` and the sync loop are untouched.
- **Session refresh (wired 2026-07-18).** The redeemed refresh token is stored in the keychain (`cloud.refresh`) alongside the access token, and `cloudFetch` refreshes on a 401 via Supabase's rotating `grant_type=refresh_token` grant, persisting the new access + refresh tokens and retrying once. Concurrent 401s share one in-flight refresh (Supabase rotates the refresh token per use, so independent refreshes would collide). This is what makes "sessions are long-lived and refreshed" true; without it the ~1h access token would force a full browser re-login every hour.
- **Stub mode unaffected.** Dev/stub auth keeps its typed `X-User-Id` — this ADR governs the supabase path only.
- **Reversible.** If OAuth is dropped, the native password form can return; nothing here is one-way.

## Accepted risk — `CLOUD_WEB_URL` on a shared Vercel subdomain (2026-08-01)

`CLOUD_WEB_URL` defaults to `https://prompt-zone-web-app.vercel.app`, and the desktop opens it for credential entry. A `*.vercel.app` name is only ours while the Vercel project exists: delete or rename that project and the subdomain becomes reclaimable by anyone, who would then be serving the page where our users type their password. The [2026-07-25 pre-launch readiness review](../reports/2026-07-25-pre-launch-readiness-review.md) listed moving to an org-owned domain as a Must Have and a hard blocker before public installer distribution.

The owner has accepted this risk for the initial launch rather than delay it. That is a deliberate trade, not an oversight, and it carries two standing obligations while it holds: **do not delete or rename the Vercel project** (that single action is what opens the takeover window), and treat the move to an org-owned DNS name — `app.promptconnext.com` or similar, set as both the `CLOUD_WEB_URL` default in `apps/engine/src/config.ts` and `NEXT_PUBLIC_APP_URL` in `apps/corp` — as the first post-launch security item, not an open-ended someday. Nothing about the handoff protocol above changes; only the origin it points at.
