# ADR 0029 — The cloud is its own OAuth authorization server

**Date:** 2026-10-25 · **Status:** Accepted · **Deciders:** product + engineering

**Prompted by the decision:** *the MCP server is a stdio binary a developer builds from source and signs into by pasting a code. The product bar is one command and a browser sign-in. What issues the tokens a hosted MCP endpoint accepts?*

**Depends on:** [ADR 0019](0019-desktop-as-vscode-extension.md) (decision 3 named the MCP server) and [ADR 0020](0020-cloud-is-the-source-of-truth.md). The design is [docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md](../superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md); the plan it completes is [plan 0025](../plans/0025-mcp-server.md) M4.

---

## Context

A hosted MCP endpoint at `{PUBLIC_API_URL}/mcp` is called by agents, not by our web app, so it cannot lean on the Supabase session cookie or a pasted Supabase JWT. The MCP authorization spec (revision 2026-07-28) is explicit: the server is an OAuth resource server, it publishes Protected Resource Metadata (RFC 9728), its authorization server publishes RFC 8414 metadata, the client binds every token to the resource with a `resource` parameter (RFC 8707), and the server must accept only tokens minted for it. Passing a token the client got for another service, a Supabase JWT included, is forbidden outright (the "token passthrough" rule). So the endpoint needs audience-bound tokens that we issue or that someone issues to us for this audience.

Three ways to get them were considered. Supabase's own OAuth server is the obvious reuse, but it is in beta, matches redirect URIs exactly (which breaks Claude Code, whose loopback callback port varies per run), and does not document resource indicators or audience binding, which the spec makes a requirement. A separate Node service built on the TypeScript SDK's auth helpers would work, but it is a second deployment with its own origin and its own copy of membership rules, and the SDK's server-side auth helpers are frozen in favour of an external authorization server. Running the authorization server inside the cloud keeps one deployment, one origin and one set of guards.

## Decision

**The cloud is the authorization server, under `/oauth/*`, bound to the Supabase identity users already have.** It serves RFC 8414 metadata at `/.well-known/oauth-authorization-server`, RFC 9728 metadata at `/.well-known/oauth-protected-resource` and `/mcp`, a JWKS at `/oauth/jwks.json`, and the authorize, token, revoke and registration endpoints. Sign-in is the existing web login page plus one consent screen at `{WEB_APP_URL}/oauth/consent`, so ADR 0014's rule that the browser is the only place sign-in happens still holds.

- **One scope, `mcp`.** The consent screen stays honest and clients that mishandle scope hierarchies cannot break. Finer scopes can be added later as additions, never by narrowing `mcp`.
- **Consent every time.** Nothing is remembered per client; the page names the signed-in account, the client's verification status and the exact redirect host first.
- **PKCE S256 only.** `plain` is refused. `resource` must equal the canonical MCP URL.
- **Tokens.** Access tokens are ES256 JWTs bound with `aud` to `{PUBLIC_API_URL}/mcp`, valid 15 minutes, carrying a family id so `/mcp` can refuse a revoked grant within 30 seconds. Refresh tokens are opaque, hashed at rest, rotate on every use, last 60 days, and tolerate a 30-second grace: within 30 s a replay of a just-rotated token receives a fresh successor in the same family (with an access token), so a client that refreshed in parallel, or kept the rotated token, is not stranded; presented again after that, the whole family is revoked. A second redemption of an authorization code revokes its family too.
- **OAuth state lives in Postgres** (`pw_oauth_clients`, `pw_oauth_requests`, `pw_oauth_codes`, `pw_oauth_refresh_tokens`, `pw_oauth_families`, migration `0014_pw_oauth.sql`), not in memory, because a rolling deploy overlaps instances and grants must be listable and revocable.
- **Client identification: CIMD, DCR and a known-client table.** Client ID Metadata Documents are fetched under an SSRF-safe pinned-address fetch; Dynamic Client Registration stays as the fallback Claude.ai and Cursor use; a client whose redirect URIs are all exact callback URIs of one vendor (or loopback, for vendors with desktop clients) is shown as Verified, anything else as Unverified with its redirect host first. A client's self-declared name is never trusted as identity.
- **No browser-binding cookie.** A request started in one browser and approved in another is not blocked by the cloud. The code reaches the client through the approving browser's redirect, and the client's own `state` check (RFC 6749 section 10.12) is the cross-browser defense. A cookie on the API origin would be a third-party cookie from the web origin, which Safari drops.
- **Identity at `/mcp` comes only from our own tokens.** The endpoint never accepts a Supabase JWT, and tool handlers call the same `require_*` guards as the HTTP routes.

## Consequences

- **Operating burden.** Five new tables and an ES256 signing key (`MCP_OAUTH_SIGNING_KEY`) to look after, per environment. Rotation is: generate a new key, move the current one to `MCP_OAUTH_PREVIOUS_SIGNING_KEY` (published in the JWKS and accepted for verification), deploy, and remove the previous key after the longest access-token lifetime has passed. The sweep loop (`OAUTH_SWEEP_INTERVAL_SECONDS`) removes expired rows and DCR clients unused for 90 days.
- **The stdio server is demoted** to the CI and offline fallback, with an npm publish workflow and no login flow beyond today's pasted code. The device-code flow plan 0025 held for M4 is dropped by this decision.
- **FastAPI major bump.** The Python `mcp` SDK 2.3 needs Starlette 1.x, so `fastapi` moves to `>=0.117,<0.200`, and the container runs uvicorn with `--proxy-headers --forwarded-allow-ips` so unauthenticated endpoints can be limited per client IP.
- **Single instance stays.** Legacy MCP sessions are held in worker memory; a client that lands on a deploy overlap re-initializes. Multi-instance would need sticky sessions or a shared event store.
- **Metering is unchanged.** Hosted planning tools write through the same routes' logic and the same ADR 0027 budget; nothing about what is free or paid moves.
- **Not covered.** Machine identity for unattended CI runners (plan 0029 M3) is a later, smaller addition; this flow is for humans.
