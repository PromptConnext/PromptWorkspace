# Hosted MCP: Streamable HTTP on the cloud, with OAuth 2.1

**Date:** 2026-10-24 · **Status:** Design, awaiting approval · **Builds on:** [plan 0025](../../plans/0025-mcp-server.md) (M4 was "HTTP transport + device-code auth"), [design 2026-10-24 local agent plans an imported repository](2026-10-24-local-agent-brownfield-planning-design.md), ADR 0014 (browser is the only place sign-in happens), ADR 0019, ADR 0020

## Intent

Today the MCP server is a stdio binary the developer builds from source, configures through a JSON file, and signs into by pasting a code. That is a prototype's shape. The product bar is what GitHub, Linear and Sentry already give their users: one command in the agent of their choice, a browser sign-in, done.

```
claude mcp add --transport http promptworkspace https://workspace-api.promptconnext.com/mcp
```

This design makes the cloud serve MCP over Streamable HTTP at `/mcp` and makes the cloud its own OAuth 2.1 authorization server, bound to the Supabase identity users already have. The stdio package survives only as the CI and offline fallback.

The user decided (2026-10-24): hosted is the one supported path for people; stdio stays for CI and offline with no login flow of its own.

## Goals

- A user connects Claude Code, Claude.ai, Cursor or ChatGPT to PromptWorkspace with the server URL alone. No install, no config file, no pasted code.
- Sign-in is the existing web login page plus one consent screen. The agent never sees a Supabase token.
- The hosted server exposes the same work the stdio server does: assigned tasks, task context, closing a task, and the three planning tools.
- Tokens are audience-bound to the MCP URL, short-lived, and revocable. Refresh tokens rotate.
- Built on `feature/trust-outcome` like the rest of this quarter's work and verified on the trust environment (`https://promptworkspace-trust-api.truthledgers.com/mcp`). When that branch merges into `develop` the same checks run on staging before production. No new service to run.

## Non-goals

- A device-code flow or any second login path for the stdio server. The stdio package keeps today's pasted-code login for CI and offline use and gets an npm publish workflow; nothing else.
- `get_project_rules` as a hosted tool. The agent has the clone and reads `AGENTS.md`, `docs/conventions.md` and the constitution itself. The hosted `start_planning` brief tells it to.
- Multi-instance deployment, SSE resumability, cross-process subscription buses. The cloud is single-instance by design (presence, limiters); this design keeps that.
- Service tokens for an unattended CI runner (plan 0029 M3). The authorization code flow here is for humans; machine identity is a later, smaller addition.
- Supabase's own OAuth server. It is beta, redirect URIs are exact-match only (breaks Claude Code's variable loopback port), and it does not document resource indicators or audience binding, which the MCP spec makes a MUST.
- Separate MCP subdomain. `/mcp` on the API origin keeps `resource`, `issuer` and the PRM on one host, which is what Claude requires to match exactly.

## Anti-goals

- Passing a Supabase JWT to an MCP client or accepting one at `/mcp`. The spec forbids token passthrough; our tokens are our own.
- A second copy of authorization rules. Hosted tools call the same `require_*` guards the HTTP routes call.
- In-memory OAuth state. The desktop handoff store is in memory because codes live 120 s; OAuth clients, codes and refresh tokens outlive a rolling deploy and go in Postgres.
- A TypeScript MCP service beside the cloud. One deployment, one origin, one auth story.

## Constraints

- MCP spec revision 2026-07-28 is current; many clients still speak 2025-11-25 (sessions, `Mcp-Session-Id`, GET stream). The server must serve both. The Python SDK `mcp` 2.3.0 does, with legacy sessions held in worker memory, which is fine on one instance; during a rolling deploy's brief overlap a legacy session may 404 and the client re-initializes.
- Spec MUSTs for the resource server: Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and the root path, 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, audience validation (RFC 8707 `resource`), Origin validation, no tokens in query strings.
- Spec MUSTs for the authorization server: RFC 8414 metadata at `/.well-known/oauth-authorization-server`, PKCE S256, `iss` in authorization responses, client registration via pre-registered ids, Client ID Metadata Documents (CIMD), and Dynamic Client Registration (DCR, deprecated but still the fallback Claude.ai and Cursor use).
- Client specifics (from vendor docs, 2026-10-24): Claude requires a real 401 to start sign-in, uses only the first `authorization_servers` entry, needs `resource` to equal the typed URL exactly, 10 s limit on discovery/registration/token calls, egress `160.79.104.0/21`. Claude Code uses CIMD with loopback redirects on any port (`http://localhost/callback`, `http://127.0.0.1/callback`). Claude.ai redirects to `https://claude.ai/api/mcp/auth_callback` (and `claude.com`). Cursor uses DCR, registers `cursor://anysphere.cursor-mcp/oauth/callback`, `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`, and redirects to the `cursor://` one (added 2026-10-25; that single URI is allowed by exact match, never a `cursor:` scheme wildcard). ChatGPT redirects `https://chatgpt.com/connector_platform_oauth_redirect` when `iss` is advertised and rejects `iss` mismatches.
- Cloud facts: auth is per-route `Depends(get_current_user)` verifying Supabase JWTs via JWKS (`app/dependencies.py`); `User` carries `id` and `email`; no token tables of any kind exist; `get_repository` returns `repo.for_user(token)` for RLS on non-graph tables while the seven graph tables always use the service role with `_guards.py` as the only enforcement; `RateLimitMiddleware` is per-path-prefix in memory; single uvicorn worker, 30 s graceful shutdown; `PUBLIC_API_URL` and `WEB_APP_URL` exist in settings; Python 3.12 image, `fastapi>=0.115,<0.117`, `PyJWT[crypto]` present; `mcp` not yet a dependency.
- Existing `/desktop-auth/*` handoff and ADR 0014 stay for the desktop app and the stdio fallback. Nothing here changes them.

## The flow the user sees

1. In Claude Code: `claude mcp add --transport http promptworkspace https://workspace-api.promptconnext.com/mcp`, then `/mcp` and pick PromptWorkspace. In Cursor: the one-click deeplink the web shows, or the JSON snippet. In Claude.ai or ChatGPT: add a custom connector with the URL.
2. The client hits `/mcp`, gets 401 with the PRM pointer, discovers the authorization server (the same origin), registers itself (CIMD or DCR) and opens the browser at `/oauth/authorize`.
3. The cloud validates the request and redirects to the web app's `/oauth/consent?request=<id>`. If the user is not signed in, the existing login page runs first and returns here.
4. The consent page names the client (from its registration), the scopes, and the workspaces the user belongs to. Approve posts to the cloud with the user's Supabase session; the cloud mints a single-use code and redirects the client's `redirect_uri` with `code`, `state` and `iss`.
5. The client exchanges the code at `/oauth/token` with its PKCE verifier and gets an access token (30 min) and a refresh token (60 days, rotating). From then on `/mcp` answers tool calls as that user.
6. In the web app, Account → Connected agents lists active grants (client name, first and last use, scopes) with Revoke.

The Planner checklist for imported projects changes its step 1 from "install and `login`" to the one-line `claude mcp add …` command with the Cursor deeplink beside it.

## Cloud: the MCP endpoint

**Canonical URL.** The resource is `{PUBLIC_API_URL}/mcp`, no trailing slash. The mount must answer `/mcp` and `/mcp/` identically with no 307 between them (Starlette's redirect-slashes behaviour is turned off for this mount), and the PRM `resource` field, `AuthSettings.resource_server_url`, the token `aud` and the connect snippets all use the slash-less form, since Claude compares `resource` to the typed URL byte for byte.

**Mounting.** `mcp` 2.3.0 `FastMCP` app mounted at `/mcp` in `create_app`, its `session_manager.run()` wrapped into the existing lifespan. `TransportSecuritySettings(allowed_hosts=[host of PUBLIC_API_URL], allowed_origins=settings.cors_origin_list)` so a bad Host gets 421 and a bad Origin 403. Uvicorn already runs behind Northflank's proxy; add `--proxy-headers`. Legacy-session mode on (default), stateless 2026-07-28 traffic served as the SDK does. `X-Accel-Buffering: no` on SSE responses is the SDK's job; verify.

**Auth hook.** `AuthSettings(issuer_url=PUBLIC_API_URL, resource_server_url=f"{PUBLIC_API_URL}/mcp", required_scopes=["mcp"], validate_token_resource=True)` and a `TokenVerifier` that validates our own JWT (signature against our JWKS, `iss`, `aud == canonical MCP URL`, `exp`, `scope`) and yields `User(id=sub, email=claim)`. The SDK serves the PRM at `/.well-known/oauth-protected-resource/mcp`; we also serve the root variant and the RFC 8414 document ourselves.

**Tools.** Implemented in Python in `app/mcp/tools.py` over the repository and the existing guards, never over HTTP to ourselves. Same names and input schemas as the stdio server minus `workspace_root`, plus project resolution by argument:

| Tool | Arguments | Behaviour |
|---|---|---|
| `list_my_tasks` | `workspace_id?`, `status?[]` | same as `GET /me/tasks` |
| `get_task` | `task_id` | criteria, spec excerpt, project and repo, branch and commit prefix (same schema as stdio) |
| `close_task` | `task_id`, `status` (`in_progress` or `implemented`; `verified` only for admins, same guard as the route), `commit_sha` (required when `status` is `implemented`) | same as `PATCH …/status`; no retry queue, a 5xx is a tool error |
| `start_planning` | `project_id` or `repo_url` | `GET /projects/{id}/planning-brief` logic; brief tells the agent to read rules files itself |
| `submit_repo_analysis` | `project_id` or `repo_url`, snapshot fields, `baseline`, `model?` | agent analysis route logic |
| `submit_stage_draft` | `project_id` or `repo_url`, `stage`, `markdown`, `model?` | draft submit logic, returns warnings |

`repo_url` resolution: normalise and match against the caller's projects' `repo_url` with the same equivalence the clients use (`git@host:a/b` equals `https://host/a/b.git`), ported from `packages/cloud-client/src/repoUrl.ts` to `app/mcp/repo_url.py` with the contract cases in `docs/contracts/` extended so the two cannot drift. Two matches is a refusal naming both; none is a refusal naming the URL.

**Repository access.** Tool handlers obtain the service-role repository and call `require_project` / `require_workspace` / `require_admin` / `require_stage_access` before any read or write, exactly as the HTTP routes do. The builder audits each route the tools mirror and confirms every read the tool performs sits behind an explicit membership check; where a route today relies on RLS through `for_user(token)` for a non-graph table (documents, projects list), the tool adds the explicit check. This audit is a deliverable, not a note. One case it must cover by name: `/me/tasks` today reads through the RLS-scoped repository, so a user removed from a workspace stops seeing tasks still assigned to them; the service-role version must filter by current membership, not by assignee alone.

**Workspace coverage.** A grant covers every workspace the user is a member of, now and later. Membership is checked on every call, so leaving a workspace ends access to it immediately. The consent page lists the user's current workspaces for information; there is no picker and no per-workspace grant table.

**Rate limiting.** Today's `RateLimitMiddleware` is one bucket per identity shared across every limited prefix, keyed by the client-supplied `X-User-Id` header first even in Supabase mode. Two changes before it can protect these routes: honour `X-User-Id` only when `AUTH_MODE=stub`; and give `/oauth/*` and `/mcp` their own limiter instances (`app/ratelimit.py` gains a named-limiter registry) so an agent's tool traffic cannot starve its own token refresh. Unauthenticated endpoints key by client IP, which requires uvicorn `--forwarded-allow-ips` set to Northflank's proxy range (new env `FORWARDED_ALLOW_IPS`, documented in `DEPLOYMENT.md`), not `--proxy-headers` alone. Buckets: `/oauth/register` 30 per hour per IP plus a global 300 per hour (Claude.ai's registrations all arrive from one Anthropic range, so per-IP alone would lock them out); every `/oauth/authorize` 60 per minute per IP, burst 20 (each writes a request row; added 2026-10-25), and with a CIMD `client_id` also 20 per hour per IP (each may be an outbound fetch); `/oauth/token` 60 per minute per `client_id` and IP together (a CIMD `client_id` is shared by every user of that client; amended 2026-10-25); `/mcp` 300 per minute per user.

## Cloud: the authorization server

New router `app/api/oauth.py`, new module `app/oauth/` (`clients.py`, `codes.py`, `tokens.py`, `keys.py`, `cimd.py`). New migration `0013_pw_oauth.sql`, three service-only tables:

- `pw_oauth_clients`: `client_id` (uuid or CIMD URL), `kind` (`preregistered | cimd | dcr`), `client_name`, `redirect_uris` (jsonb), `client_uri`, `logo_uri`, `token_endpoint_auth_method` (`none`), `created_at`, `last_used_at`, `metadata` (jsonb). DCR rows unused for 90 days are purged by the existing sweep loop.
- `pw_oauth_requests`: `request_id` (uuid) primary, `client_id`, `redirect_uri`, `code_challenge`, `resource`, `scope`, `state`, `created_at`, `expires_at` (now + 10 min), `approved_user_id`, `approved_at`, `denied_at`. One row per `/oauth/authorize` visit.
- `pw_oauth_codes`: `code_hash` (sha256) primary, `request_id`, `family_id` (uuid minted with the code), `client_id`, `user_id`, `redirect_uri`, `code_challenge`, `resource`, `scope`, `expires_at` (now + 5 min), `used_at`. Single use: a second redemption revokes the family (RFC 6749 §4.1.2).
- `pw_oauth_refresh_tokens`: `token_hash` primary, `family_id`, `client_id`, `user_id`, `scope`, `resource`, `issued_at`, `expires_at` (60 days), `rotated_to_hash`, `rotated_at`, `revoked_at`, `last_used_at`, `user_agent`. Rotation on every use. A rotated token presented again within 30 s of its rotation receives a fresh successor in the same family (clients that refresh in parallel; amended 2026-10-25, since the first successor's raw value is never stored and returning no refresh token stranded SDK clients); the rotated row still points at its first successor and both successors are live. After that window it is reuse and the whole family is revoked.
- `pw_oauth_families`: `family_id` primary, `client_id`, `user_id`, `created_at`, `revoked_at`, `revoked_reason`. The unit of revocation and what Connected agents lists. Access tokens carry `fid`; `/mcp` refuses a token whose family is revoked (one indexed read per call, cached in-process for 30 s), so "revoke" means within 30 s, not within the access-token lifetime.

Endpoints:

- `GET /.well-known/oauth-authorization-server` (also under `/mcp` path-inserted variant): `issuer = PUBLIC_API_URL`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, `revocation_endpoint`, `jwks_uri`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `response_types_supported: ["code"]`, `token_endpoint_auth_methods_supported: ["none"]`, `scopes_supported: ["mcp"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`. No `offline_access` advertised.
- `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`: `resource = {PUBLIC_API_URL}/mcp`, `authorization_servers = [PUBLIC_API_URL]`, `scopes_supported = ["mcp"]`, `bearer_methods_supported = ["header"]`.
- `GET /oauth/jwks.json`: our public keys with `kid`.
- Known clients: a static table in `app/oauth/known_clients.py` of the exact callback URIs that identify a vendor (amended 2026-10-25 from redirect hosts: Claude `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`; Cursor `https://www.cursor.com/agents/mcp/oauth/callback` and `cursor://anysphere.cursor-mcp/oauth/callback`; ChatGPT `https://chatgpt.com/connector_platform_oauth_redirect`; plus loopback for Claude Code and Cursor desktop). A registration whose redirect URIs are all in one vendor's set is shown as that vendor with a Verified mark; anything else is shown as **Unverified** with its exact redirect host in the consent page's first line, and its self-declared name and logo are shown smaller, after that. DCR and CIMD names are never trusted as identity.
- `POST /oauth/register` (DCR): accepts `redirect_uris`, `client_name`, `client_uri`, `logo_uri`, `application_type`, `token_endpoint_auth_method` must be `none`; stores and returns `client_id`. Rate-limited.
- `GET /oauth/authorize`: requires `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256`, `resource` equal to the canonical MCP URL, `scope` (default `mcp`), `state`. Resolves the client: a `https://` `client_id` is a CIMD, fetched with `cimd.py` (HTTPS only, public IPs only, 10 s, 64 KB cap, cached 1 h) and must list the `redirect_uri`; otherwise the stored client. `redirect_uri` must equal a registered one exactly, except loopback: `http://localhost` and `http://127.0.0.1` match on any port and the registered path. Errors before a valid client and redirect are rendered as an HTML error, never redirected. Valid requests are stored in `pw_oauth_requests` and the user is redirected to `{WEB_APP_URL}/oauth/consent?request=<request_id>`.
- `GET /oauth/authorize/{request_id}` (web consent reads it with the Supabase bearer): client display fields, `verified` flag, redirect host, scopes, and the signed-in account's email. 404 when expired or already decided.
- `POST /oauth/authorize/{request_id}/approve` and `/deny` (web consent, Supabase bearer): a cross-site page cannot obtain the bearer, so these cannot be triggered by CSRF. A request started in one browser and approved in another is not blocked here on purpose: the code is delivered through the approving browser to the client's `redirect_uri`, where the client checks `state` against its own session (RFC 6749 §10.12), which is the defense every major provider relies on; a cookie binding on the API origin would be a third-party cookie from the web origin and Safari drops it. Approve mints the code and a `family_id`, stores the code hash with the user id, and returns the final redirect URL (`redirect_uri?code=…&state=…&iss=…`); the web navigates there. Deny returns `error=access_denied`. Consent is shown on every authorization; nothing is remembered per client.
- `POST /oauth/token` (form-urlencoded): `authorization_code` with `code_verifier` checked against `code_challenge`, `redirect_uri` and `client_id` matching the stored request; `refresh_token` with rotation. On every refresh the cloud confirms the Supabase account still exists and is not banned (`GET /auth/v1/admin/users/{id}` with the service key, result cached 5 min); a missing or banned user gets `invalid_grant` and the family is revoked. Both grants return `{access_token, token_type: "Bearer", expires_in: 900, refresh_token, scope}`. Errors use RFC 6749 bodies; a bad or reused refresh token is `invalid_grant`. No CORS headers on this endpoint: every supported client calls it from a process, not a browser page.
- `POST /oauth/revoke`: revokes a family. `/mcp` stops accepting its access tokens within 30 s.
- Password reset and "sign out everywhere" in the web app call `DELETE /me/oauth-grants` (all families) after they succeed.

**Tokens.** Access tokens are JWTs signed ES256 with a key from `MCP_OAUTH_SIGNING_KEY` (PEM; `kid` from its thumbprint), claims `iss`, `sub` (Supabase user id), `aud` (canonical MCP URL), `client_id`, `fid` (family id), `scope`, `email`, `iat`, `exp` (15 min), `jti`. Refresh tokens are opaque `secrets.token_urlsafe(48)`, stored hashed. Nothing about the Supabase session is embedded; the consent step already proved the user.

**Settings.** `MCP_ENABLED` (default false; trust and production set true), `MCP_OAUTH_SIGNING_KEY` (required when enabled; boot refuses without it), `PUBLIC_API_URL` (required when enabled), `MCP_ACCESS_TOKEN_TTL_SECONDS=900`, `MCP_REFRESH_TOKEN_TTL_DAYS=60`, `OAUTH_SWEEP_INTERVAL_SECONDS=600` (its own loop; expired requests, codes, tokens and DCR clients unused for 90 days), `FORWARDED_ALLOW_IPS`. Key rotation: a second `MCP_OAUTH_PREVIOUS_SIGNING_KEY` is published in JWKS and accepted for verification until removed.

## Web

- `/oauth/consent` page (requires auth; it returns through the login page's existing `?next=` parameter, whose `safeNext` in `apps/web/src/lib/next-path.ts` must first be tightened to accept only a single leading `/` followed by a non-slash, non-backslash character, rejecting `//host`, `/\host` and anything with a scheme; the email-confirmation path on sign-up needs `{WEB_APP_URL}/oauth/consent*` in Supabase's redirect allow-list or the return is lost, which `DEPLOYMENT.md` records). The page sends `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` via `next.config` headers so Approve cannot be clickjacked. It shows the signed-in account's email beside Approve, the client's verification status and redirect host first, then client name and logo, scopes in words ("Read and update your tasks and planning documents in PromptWorkspace"), the workspaces this will apply to, Approve and Deny. Approve calls the cloud and navigates to the returned URL.
- Account → **Connected agents**: list grants from a new `GET /me/oauth-grants` (client, scopes, created, last used) with Revoke (`DELETE /me/oauth-grants/{family_id}`).
- Workspace settings and the Planner checklist: the connect snippet per client (Claude Code command, Cursor deeplink and JSON, "custom connector URL" for Claude.ai and ChatGPT), reading the API URL from config so trust and production differ only by env.

## stdio package

- Unchanged behaviour. `apps/mcp` README reframes it as the CI and offline fallback and points people at the hosted URL first.
- New `.github/workflows/mcp-publish.yml`: on a `mcp-v*` tag, build and `npm publish` `@promptconnext/promptworkspace-mcp` with provenance. Needs an `NPM_TOKEN` repository secret the user creates. Until then the tarball release stays.
- CLAUDE.md and plan 0025 updated: M4 is delivered as hosted HTTP with OAuth; the device-code flow is dropped by decision.

## Security

- PKCE S256 only; `plain` refused. `resource` required and must equal the canonical URL exactly; tokens carry it as `aud` and `/mcp` validates it.
- Redirect URIs exact-match, loopback port-agnostic only for `localhost` and `127.0.0.1` with `http`. HTTPS required for every other redirect.
- Authorization codes: 5 minutes, single use, hashed at rest, bound to client, redirect URI, challenge, resource and user. Reuse revokes derived tokens.
- Refresh tokens: hashed at rest, rotated per use, family revoked on reuse, 60 days absolute, revocable by the user.
- CIMD fetches: HTTPS on port 443 only; the hostname is resolved once, every resolved address (IPv4, IPv6, IPv4-mapped and NAT64 forms) is checked against private, loopback, link-local and multicast ranges, and the connection is pinned to the checked address (httpx transport with a fixed-address resolver and the original hostname for SNI and `Host`) so DNS rebinding cannot swap it; redirects not followed, 10 s and 64 KB caps, result cached 1 h, `client_id` must equal the document's `client_id`; triggering fetches is rate-limited per IP since `/oauth/authorize` is unauthenticated.
- DCR: rate-limited per IP, unused clients purged after 90 days, `token_endpoint_auth_method` must be `none`, no secrets ever stored.
- Consent on every authorization; the consent page shows the signed-in account, the client's verification status and the exact `redirect_uri` host first, so a user can spot an impostor. No browser-binding cookie (2026-10-25 ruling, see the approve route): the client's `state` check is the defense against a request approved in a browser other than the one that started it.
- Origin and Host validation on `/mcp` via `TransportSecuritySettings`; CORS for `/oauth/*` limited to the web origin plus the token endpoint allowing no credentials.
- `/mcp` and `/oauth/*` rate-limited; `/oauth/token` additionally per `client_id`.
- Tool handlers run the same guards as HTTP routes; the audit in "Repository access" is required before enabling in production.
- Tokens never logged; `jti` and `family_id` are what logs reference.

## Decisions made in conversation

- Hosted HTTP with OAuth is the one supported path for people; stdio stays for CI and offline only, with npm publish and no new login flow.
- Production-grade means URL plus browser sign-in, no install and no pasted code.

## Calls made by the author

- The cloud is its own authorization server rather than using Supabase's beta OAuth server (exact-match redirects, no documented audience binding) or a separate Node service (second deployment, frozen auth helpers in the TS SDK).
- Python SDK `mcp` 2.3.0 mounted in FastAPI; tools reimplemented in Python over the repository and guards, not proxied to our own HTTP routes.
- `/mcp` on the API origin, no subdomain.
- One scope, `mcp`, so the consent screen is honest and clients that mishandle scope hierarchies cannot break. Finer scopes can be added later as additions, never by narrowing `mcp`.
- `close_task` requires `commit_sha` on the hosted server; no retry queue.
- `get_project_rules` not hosted; the brief tells the agent to read the files itself.
- Loopback redirect matching port-agnostic for `localhost` and `127.0.0.1`, per Claude Code's behaviour.
- Access 30 min, refresh 60 days rotating, codes 5 min.
- OAuth state in Postgres, not memory, because rolling deploys overlap and grants must be listable and revocable.
- Legacy MCP sessions in memory on one instance; a client that lands on the 30 s deploy overlap re-initializes.
- Device-code flow for stdio dropped.
- Added after the builder check (2026-10-25): a grant spans all current and future workspaces, membership checked per call; `close_task` keeps the stdio schema (`task_id`, `status`, `commit_sha` required for `implemented`); consent shown every time; access tokens 15 min with a per-call family-revocation check cached 30 s; refresh re-checks the Supabase account; 30 s refresh-rotation grace; known-client table with Verified/Unverified display; named limiter instances and `X-User-Id` honoured only in stub mode; `safeNext` tightened; consent page framing denied; CIMD fetch pinned to the checked address.
- 2026-10-25: `fastapi` bumped to `>=0.117,<0.200` because `mcp` 2.3 needs Starlette 1.x; the Dockerfile CMD gained `--proxy-headers --forwarded-allow-ips`.
- 2026-10-25: migration `0014_pw_oauth_family_last_used` folded into `0013_pw_oauth` (`pw_oauth_families.last_used_at`), since nothing from this branch is deployed; the design's table list above predates it.
- 2026-10-25: `resource` is optional at the token endpoint (clients that sent it at `/oauth/authorize` are bound by the stored request, and a mismatch is still refused); it is required at authorize.
- 2026-10-25: `verify_access_token(public_keys=...)` takes the published key set so `/mcp` verification caches the JWKS in process instead of rebuilding it per call.

## Left to the builder

- Exact SDK wiring for dual-mode (2026-07-28 stateless plus legacy sessions) and verifying each client's behaviour against trust: Claude Code, Claude.ai, Cursor, ChatGPT. A test matrix with the observed protocol revision per client is a deliverable.
- The membership audit of every repository read the tools perform.
- Porting `repoUrl.ts` matching to Python and extending `docs/contracts/` with shared cases.
- Consent page design within the existing auth page styling.
- Whether `GET /oauth/authorize` renders errors through a small Jinja template or a static HTML string.
- Sweep job cadence for expired codes, refresh tokens and stale DCR clients (reuse the existing decision sweep loop).
- Test plan: cloud tests for every endpoint and error branch (PKCE mismatch, resource mismatch, redirect mismatch, code reuse revoking tokens, refresh reuse revoking the family, expired code, CIMD SSRF refusals, DCR validation), `TokenVerifier` unit tests, an end-to-end test driving the Python SDK's HTTP client through 401 → metadata → token → tool call against the in-memory backend with a fake consent step, RLS probes for the three tables, web tests for consent and connected agents.
- Northflank SSE idle timeout: measure on trust; document the finding in `DEPLOYMENT.md`.

## Open items carried forward

- Machine identity for the CI runner (plan 0029 M3): a `client_credentials`-like grant or a workspace service token, after this ships.
- Finer scopes if a customer asks for read-only connectors.
- Multi-instance: sticky sessions or a shared event store, only if the single-instance constraint is ever lifted for the cloud as a whole.
