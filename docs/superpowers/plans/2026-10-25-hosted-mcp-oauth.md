# Hosted MCP with OAuth 2.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The cloud serves MCP over Streamable HTTP at `/mcp` and is its own OAuth 2.1 authorization server, so a user connects Claude Code, Claude.ai, Cursor or ChatGPT with the URL alone and a browser consent.

**Architecture:** `app/oauth/` (keys, tokens, clients, CIMD fetch, known clients) and a new `app/api/oauth.py` router implement RFC 8414 metadata, RFC 9728 protected-resource metadata, DCR, authorize, consent approve/deny, token, revoke and grant listing over four service-only tables (migration 0013). `app/mcp/` mounts `mcp` 2.3.0 `MCPServer` with a `TokenVerifier` for our ES256 JWTs and implements six tools in Python over the repository and existing guards. `apps/web` gains `safeNext` hardening, `/oauth/consent`, `/account/agents`, and connect snippets. Named rate limiters replace the single shared bucket for `/oauth/*` and `/mcp`.

**Tech Stack:** FastAPI, pydantic v2, PyJWT[crypto] (ES256), `mcp==2.3.0`, httpx with a pinned-address transport, Postgres via existing repository adapters, pytest; Next.js 16 + vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md`

## Global Constraints

- Canonical resource URL is `{PUBLIC_API_URL}/mcp` with no trailing slash; `/mcp` and `/mcp/` both answer, no 307 between them. PRM `resource`, `AuthSettings.resource_server_url`, token `aud` and every connect snippet use the slash-less form.
- Issuer is `PUBLIC_API_URL`. AS metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/mcp`; PRM at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.
- One scope: `mcp`. `scopes_supported: ["mcp"]`. `offline_access` never advertised.
- PKCE S256 only. `resource` required on authorize and token, must equal the canonical URL. `iss` returned in authorization responses; `authorization_response_iss_parameter_supported: true`; `client_id_metadata_document_supported: true`; `token_endpoint_auth_methods_supported: ["none"]`; `code_challenge_methods_supported: ["S256"]`; `grant_types_supported: ["authorization_code","refresh_token"]`; `response_types_supported: ["code"]`.
- Access token: JWT ES256, claims `iss, sub, aud, client_id, fid, scope, email, iat, exp, jti`, TTL `MCP_ACCESS_TOKEN_TTL_SECONDS=900`. Refresh: opaque `secrets.token_urlsafe(48)`, sha256 at rest, TTL `MCP_REFRESH_TOKEN_TTL_DAYS=60`, rotated per use, 30 s grace returning the same successor, reuse after grace revokes the family. Codes: 5 min, single use, hashed; reuse revokes the family. Pending requests: 10 min.
- Redirect URIs: exact match, except `http://localhost` and `http://127.0.0.1` match any port with the registered path. Every other redirect must be `https`.
- Tables `pw_oauth_clients`, `pw_oauth_requests`, `pw_oauth_codes`, `pw_oauth_refresh_tokens`, `pw_oauth_families`: service-only (RLS on, no policy, grants revoked from `authenticated`/`anon`, `service_role` granted), names added to `_SERVICE_ONLY_TABLES`. Migration file `apps/cloud/migrations/0013_pw_oauth.sql`; check the directory first.
- Settings (env names are the upper-cased field names): `MCP_ENABLED` (default false), `MCP_OAUTH_SIGNING_KEY` (PEM EC P-256 private key; boot refuses when enabled and missing), `MCP_OAUTH_PREVIOUS_SIGNING_KEY` (optional), `MCP_ACCESS_TOKEN_TTL_SECONDS`, `MCP_REFRESH_TOKEN_TTL_DAYS`, `OAUTH_SWEEP_INTERVAL_SECONDS=600`, `FORWARDED_ALLOW_IPS`. `PUBLIC_API_URL` required when `MCP_ENABLED`.
- Tool handlers call the service-role repository and the existing `require_*` guards before any read or write; `/me/tasks` equivalent filters by current membership.
- CIMD fetch: `https` port 443 only, resolve once, reject private/loopback/link-local/multicast/IPv4-mapped/NAT64 addresses, connect pinned to the checked address with the hostname for SNI and `Host`, no redirects, 10 s, 64 KB, cached 1 h, `client_id` must equal the document's `client_id`.
- Never run `ruff format`. Cloud verification: `cd apps/cloud && .venv/bin/pytest -q && .venv/bin/ruff check .`. Web: `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`. MCP package: `pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp test`.
- Commits: scoped Conventional Commits (`feat(cloud): …`, `feat(web): …`, `docs: …`).

## Review Focus

1. A `redirect_uri` of `http://localhost.evil.com/callback` or `http://localhost@evil.com/` must not pass loopback matching; test in Task 6.
2. A CIMD `client_id` whose hostname resolves to `127.0.0.1`, `::1`, `::ffff:10.0.0.1` or `169.254.169.254` must be refused before any connection; test in Task 5.
3. Approving a request from a browser without the `pw_oauth_req` cookie, or with a cookie for a different request, must be refused; test in Task 6.
4. A refresh token presented 31 s after it was rotated must revoke the whole family and the family's access tokens must fail at `/mcp` within 30 s; tests in Tasks 7 and 8.
5. `/mcp` must reject a valid Supabase JWT (wrong `aud`) and a PromptWorkspace token whose `aud` is the trust URL when the server runs as production; test in Task 8.

---

### Task 1: Settings, signing keys, token issue and verify

**Files:**
- Modify: `apps/cloud/app/config.py` (fields after `public_api_url`; new check in `require_production_safety` style, called from `_build_repository` alongside `require_auth`)
- Create: `apps/cloud/app/oauth/__init__.py`, `apps/cloud/app/oauth/keys.py`, `apps/cloud/app/oauth/tokens.py`
- Modify: `apps/cloud/requirements.txt` (add `mcp>=2.3,<3`)
- Test: `apps/cloud/tests/test_oauth_tokens.py`

**Interfaces:**
- Produces:
  ```python
  # config.py Settings
  mcp_enabled: bool = False
  mcp_oauth_signing_key: str = ""          # PEM, EC P-256 private key
  mcp_oauth_previous_signing_key: str = ""
  mcp_access_token_ttl_seconds: int = 900
  mcp_refresh_token_ttl_days: int = 60
  oauth_sweep_interval_seconds: int = 600
  forwarded_allow_ips: str = ""
  @property canonical_mcp_url -> str        # f"{public_api_url.rstrip('/')}/mcp"
  def require_mcp(self) -> None             # RuntimeError when mcp_enabled and (no signing key or no public_api_url)

  # keys.py
  @dataclass(frozen=True) class SigningKey: kid: str; private_pem: str; public_jwk: dict
  def load_signing_keys(settings) -> tuple[SigningKey, SigningKey | None]   # current, previous
  def jwks(keys: Iterable[SigningKey]) -> dict                               # {"keys": [...]}
  def kid_for(public_key) -> str                                             # RFC 7638 thumbprint, base64url

  # tokens.py
  @dataclass(frozen=True) class AccessClaims: sub: str; email: str; client_id: str; family_id: str; scope: str; jti: str; exp: datetime
  def issue_access_token(settings, key: SigningKey, *, sub, email, client_id, family_id, scope="mcp", now=None) -> tuple[str, AccessClaims]
  class TokenError(ValueError): code: str   # "invalid_signature" | "wrong_audience" | "expired" | "wrong_issuer" | "malformed"
  def verify_access_token(settings, keys: Iterable[SigningKey], token: str, *, now=None) -> AccessClaims
  def new_refresh_token() -> tuple[str, str]   # (raw, sha256 hex)
  def hash_token(raw: str) -> str
  ```

- [ ] **Step 1: Write failing tests**

```python
def test_issue_and_verify_round_trip(settings_with_key):
    key, _ = load_signing_keys(settings_with_key)
    token, claims = issue_access_token(settings_with_key, key, sub="u1", email="u@x", client_id="c1", family_id="f1")
    back = verify_access_token(settings_with_key, [key], token)
    assert (back.sub, back.client_id, back.family_id, back.scope) == ("u1", "c1", "f1", "mcp")
    header = jwt.get_unverified_header(token); assert header["alg"] == "ES256" and header["kid"] == key.kid

def test_wrong_audience_is_refused(settings_with_key): ...   # token minted with aud "https://other/mcp" -> TokenError("wrong_audience")
def test_supabase_shaped_token_is_refused(settings_with_key): ...  # HS256 token with aud "authenticated" -> TokenError
def test_previous_key_still_verifies(settings_with_two_keys): ...
def test_jwks_lists_current_and_previous_with_kids(settings_with_two_keys): ...
def test_require_mcp_refuses_enabled_without_key_or_public_url(): ...
def test_refresh_token_is_48_bytes_urlsafe_and_hash_is_sha256(): ...
```

Generate test keys with `cryptography` (`ec.generate_private_key(ec.SECP256R1())`) in a fixture; put the PEM into `Settings(mcp_enabled=True, mcp_oauth_signing_key=pem, public_api_url="https://api.test")`.

- [ ] **Step 2: Run, expect ImportError**

Run: `cd apps/cloud && .venv/bin/pytest tests/test_oauth_tokens.py -q`

- [ ] **Step 3: Implement settings fields, `require_mcp`, `keys.py`, `tokens.py`; call `settings.require_mcp()` where `require_auth()` is called in `main.py::_build_repository`**

`verify_access_token` uses `jwt.decode(token, key, algorithms=["ES256"], audience=settings.canonical_mcp_url, issuer=settings.public_api_url)` selecting the key by `kid`; a token without `kid` or with an unknown `kid` is `malformed`.

- [ ] **Step 4: Install the dependency into the venv and run tests and lint**

Run: `cd apps/cloud && .venv/bin/pip install -q "mcp>=2.3,<3" && .venv/bin/pytest tests/test_oauth_tokens.py -q && .venv/bin/ruff check .`
Expected: PASS. Note the `mcp` import is not used yet; the install proves it coexists with `httpx>=0.27,<0.29` (it depends on `httpx2`, a separate distribution).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): OAuth settings, ES256 signing keys, access token issue and verify"
```

---

### Task 2: Migration 0013, models and repository for OAuth state

**Files:**
- Create: `apps/cloud/migrations/0013_pw_oauth.sql`
- Modify: `apps/cloud/app/models/schemas.py` (new block after `StageDraft`)
- Modify: `apps/cloud/app/db/repository.py` (ABC + InMemory), `apps/cloud/app/db/supabase_repository.py` (impl + `_SERVICE_ONLY_TABLES` + table constants)
- Test: `apps/cloud/tests/test_oauth_repo.py`, `apps/cloud/tests/contract/test_oauth_store.py`

**Interfaces:**
- Produces:
  ```python
  OAuthClientKind = Literal["preregistered", "cimd", "dcr"]
  class OAuthClient(BaseModel): client_id: str; kind: OAuthClientKind; client_name: str = ""; redirect_uris: list[str]; client_uri: str | None = None; logo_uri: str | None = None; token_endpoint_auth_method: Literal["none"] = "none"; metadata: dict = {}; created_at: datetime; last_used_at: datetime | None = None
  class OAuthRequest(BaseModel): request_id: str = new_id(); client_id: str; redirect_uri: str; code_challenge: str; resource: str; scope: str; state: str | None; browser_binding_hash: str; created_at; expires_at; approved_user_id: str | None = None; approved_at: datetime | None = None; denied_at: datetime | None = None
  class OAuthCode(BaseModel): code_hash: str; request_id: str; family_id: str; client_id: str; user_id: str; redirect_uri: str; code_challenge: str; resource: str; scope: str; expires_at; used_at: datetime | None = None
  class OAuthRefreshToken(BaseModel): token_hash: str; family_id: str; client_id: str; user_id: str; scope: str; resource: str; issued_at; expires_at; rotated_to_hash: str | None = None; rotated_at: datetime | None = None; revoked_at: datetime | None = None; last_used_at: datetime | None = None; user_agent: str | None = None
  class OAuthFamily(BaseModel): family_id: str; client_id: str; user_id: str; created_at; revoked_at: datetime | None = None; revoked_reason: str | None = None

  # Repository ABC (all abstract):
  get_oauth_client(client_id) -> OAuthClient | None; upsert_oauth_client(c) -> OAuthClient; delete_oauth_clients_unused_since(cutoff, kind="dcr") -> int
  put_oauth_request(r) -> OAuthRequest; get_oauth_request(request_id) -> OAuthRequest | None; update_oauth_request(r) -> OAuthRequest; delete_oauth_requests_expired(now) -> int
  put_oauth_code(c) -> OAuthCode; take_oauth_code(code_hash, now) -> OAuthCode | None   # atomic: returns the row and marks used_at; a second call returns None
  get_oauth_code(code_hash) -> OAuthCode | None
  put_refresh_token(t) -> OAuthRefreshToken; get_refresh_token(token_hash) -> OAuthRefreshToken | None; update_refresh_token(t) -> OAuthRefreshToken; delete_refresh_tokens_expired(now) -> int
  put_oauth_family(f) -> OAuthFamily; get_oauth_family(family_id) -> OAuthFamily | None; revoke_oauth_family(family_id, reason, now) -> OAuthFamily | None; list_oauth_families_for_user(user_id) -> list[OAuthFamily]; revoke_oauth_families_for_user(user_id, reason, now) -> int
  ```

- [ ] **Step 1: Write failing repository tests (memory) and the contract file modelled on `tests/contract/test_line_links.py`**

Cases: client round trip and DCR purge by cutoff; request put/get/update and expiry purge; `take_oauth_code` returns once; refresh token rotation fields persist; family revoke returns the row and `list_oauth_families_for_user` orders by `created_at` desc; `revoke_oauth_families_for_user` count.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Write the migration (five tables, all service-only, `DEPLOY ORDER: apply before deploying this code`), the models, both adapters (`_OAUTH_CLIENTS = "pw_oauth_clients"` etc.), and the `_SERVICE_ONLY_TABLES` entries**

`take_oauth_code` on Supabase: `update ... set used_at=now where code_hash=? and used_at is null returning *`, via `.update({...}).eq("code_hash", h).is_("used_at", "null").execute()` and checking `res.data`.

- [ ] **Step 4: Run tests and lint, expect PASS (contract parameter skips without Supabase env)**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): OAuth clients, requests, codes, refresh tokens and families (migration 0013)"
```

---

### Task 3: Named rate limiters and identity hardening

**Files:**
- Modify: `apps/cloud/app/ratelimit.py`, `apps/cloud/app/main.py` (middleware install), `apps/cloud/Dockerfile` (CMD gains `--proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}"`)
- Test: `apps/cloud/tests/test_ratelimit.py` (extend or create)

**Interfaces:**
- Produces:
  ```python
  @dataclass class LimitRule: name: str; match: Callable[[Request], bool]; key: Callable[[Request], str]; limiter: TokenBucketLimiter
  class RateLimitMiddleware(BaseHTTPMiddleware): def __init__(self, app, rules: list[LimitRule]) -> None   # first matching rule applies
  def identity(request, *, stub_mode: bool) -> str    # "user:<x-user-id>" only when stub_mode; else "tok:<last 24>" else "ip:<client.host>"
  def default_rules(settings) -> list[LimitRule]      # existing prefixes/suffixes as one rule named "api"; plus:
  #   "oauth_register": POST /oauth/register, key ip, 30/hour burst 5, and a second global key "all" 300/hour
  #   "oauth_authorize_cimd": GET /oauth/authorize with https:// client_id, key ip, 20/hour burst 5
  #   "oauth_token": POST /oauth/token, key "client:<client_id form field or query>", 60/min burst 20
  #   "mcp": path startswith /mcp, key identity, 300/min burst 60
  ```
  Per-hour buckets are `TokenBucketLimiter(per_minute=rate/60, burst=burst)`.

- [ ] **Step 1: Write failing tests**: `X-User-Id` ignored for identity when `stub_mode=False`; `/oauth/register` 31st call in an hour from one IP is 429 while a different IP passes; `/mcp` traffic does not consume the `/oauth/token` bucket; existing `/sync` behaviour unchanged (keep the existing test file's cases green).

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement; `main.py` builds `default_rules(settings)` and passes `stub_mode=settings.auth_mode == "stub"`**

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): named rate limiters for oauth and mcp; X-User-Id identity only in stub mode"
```

---

### Task 4: Discovery metadata, JWKS and known clients

**Files:**
- Create: `apps/cloud/app/api/oauth.py` (router, no prefix), `apps/cloud/app/oauth/known_clients.py`
- Modify: `apps/cloud/app/main.py` (`include_router(oauth.router)` after `desktop_auth.router`, only when `settings.mcp_enabled`)
- Test: `apps/cloud/tests/test_oauth_discovery.py`

**Interfaces:**
- Produces:
  ```python
  # routes
  GET /.well-known/oauth-authorization-server            -> AS metadata (fields in Global Constraints; endpoints built from public_api_url)
  GET /.well-known/oauth-authorization-server/mcp        -> same body
  GET /.well-known/oauth-protected-resource              -> {"resource": canonical_mcp_url, "authorization_servers": [public_api_url], "scopes_supported": ["mcp"], "bearer_methods_supported": ["header"]}
  GET /.well-known/oauth-protected-resource/mcp          -> same body
  GET /oauth/jwks.json                                   -> jwks(current, previous)
  # known_clients.py
  @dataclass(frozen=True) class KnownClient: vendor: str; redirect_hosts: frozenset[str]; loopback: bool
  KNOWN: tuple[KnownClient, ...]   # Claude: {"claude.ai","claude.com"}, loopback True; Cursor: {"www.cursor.com"}, loopback True (any port, path /callback); ChatGPT: {"chatgpt.com"}; 
  def classify(redirect_uris: list[str]) -> tuple[str | None, bool]   # (vendor, verified): verified only if every URI's host is in one vendor's set or is loopback for a loopback vendor
  ```
  All five metadata routes set `Cache-Control: public, max-age=300`. Metadata routes are registered even when `MCP_ENABLED` is false? No: the whole router mounts only when enabled, so an unconfigured deployment has no OAuth surface.

- [ ] **Step 1: Write failing tests** (client fixture with `MCP_ENABLED=1`, signing key env, `PUBLIC_API_URL=https://api.test` set via `monkeypatch.setenv` before `create_app()` and `get_settings.cache_clear()`): every required metadata field and exact values; both PRM paths identical; JWKS has `kid`s; router absent when disabled (404 on `/oauth/jwks.json`); `classify` for Claude Code loopback, Claude.ai, Cursor desktop+web, ChatGPT, and a mixed/unknown set → `(None, False)`.

- [ ] **Step 2: Run, expect 404s**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): OAuth authorization-server and protected-resource metadata, JWKS, known clients"
```

---

### Task 5: Client registration: DCR and CIMD

**Files:**
- Create: `apps/cloud/app/oauth/clients.py`, `apps/cloud/app/oauth/cimd.py`
- Modify: `apps/cloud/app/api/oauth.py`, `apps/cloud/app/models/schemas.py` (`DcrRegistrationIn`, `DcrRegistrationOut`)
- Test: `apps/cloud/tests/test_oauth_registration.py`

**Interfaces:**
- Produces:
  ```python
  class DcrRegistrationIn(BaseModel): redirect_uris: list[AnyUrl] (1..10); client_name: str = Field("", max_length=120); client_uri: AnyHttpUrl | None = None; logo_uri: AnyHttpUrl | None = None; application_type: Literal["web","native"] | None = None; token_endpoint_auth_method: Literal["none"] = "none"; grant_types: list[str] | None = None; response_types: list[str] | None = None; scope: str | None = None
  class DcrRegistrationOut(BaseModel): client_id: str; client_id_issued_at: int; redirect_uris: list[str]; client_name: str; token_endpoint_auth_method: Literal["none"]; grant_types: list[str]; response_types: list[str]
  POST /oauth/register -> 201 DcrRegistrationOut; 400 {"error":"invalid_redirect_uri" | "invalid_client_metadata", "error_description"}

  # clients.py
  class RedirectError(ValueError): ...
  def validate_redirect_uri(candidate: str, registered: list[str]) -> str   # returns the matched registered URI; loopback rule; raises RedirectError
  def is_loopback(url) -> bool   # scheme http, hostname exactly "localhost" or "127.0.0.1" (parsed hostname, not string prefix), no userinfo
  async def resolve_client(repo, client_id: str, *, cimd_fetch) -> OAuthClient   # stored row, else if client_id startswith "https://": fetch CIMD, upsert kind "cimd"; raises UnknownClient

  # cimd.py
  class CimdError(ValueError): code: str   # "not_https" | "bad_port" | "private_address" | "too_large" | "timeout" | "invalid_document" | "client_id_mismatch"
  def check_address(ip: str) -> None     # raises on private/loopback/link-local/multicast/unspecified; unwraps ::ffff:a.b.c.d and 64:ff9b::/96 before checking
  async def fetch_client_metadata(client_id: str, *, now=None, cache: dict) -> OAuthClient   # resolves host once (getaddrinfo), checks every address, connects to the first good address with an httpx transport whose resolver is pinned (hostname kept for SNI/Host), follow_redirects=False, timeout 10, reads at most 65536 bytes, caches by client_id for 3600 s
  ```

- [ ] **Step 1: Write failing tests**: DCR happy path and each refusal (`https` required for non-loopback, `token_endpoint_auth_method` other than `none`, 11 URIs); `validate_redirect_uri` for Review Focus 1 (`http://localhost.evil.com/callback`, `http://localhost@evil.com/`, `http://localhost:9999/callback` vs registered `http://localhost/callback` ok, path mismatch refused); `check_address` for Review Focus 2 plus `10.0.0.1`, `192.168.1.1`, `fd00::1`, `fe80::1`, `0.0.0.0`; `fetch_client_metadata` with a monkeypatched resolver returning a private address → `CimdError("private_address")` and no transport call; a document whose `client_id` differs → `client_id_mismatch`; redirect response → `invalid_document`; body over 64 KB → `too_large`; second call within the hour served from cache without resolving.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**. For the pinned transport use `httpx.AsyncHTTPTransport` with `local_address` unset and a custom `httpx.AsyncClient(transport=..., mounts=...)` where the request URL host is replaced by the IP literal, headers `Host: <hostname>`, and SNI via `httpx.create_ssl_context()` plus `extensions={"sni_hostname": hostname}`. Read the body with `aiter_bytes` and stop past 65536.

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): dynamic client registration and SSRF-safe client ID metadata documents"
```

---

### Task 6: Authorize, consent read, approve and deny

**Files:**
- Modify: `apps/cloud/app/api/oauth.py`, `apps/cloud/app/models/schemas.py` (`ConsentView`, `ConsentDecisionOut`)
- Test: `apps/cloud/tests/test_oauth_authorize.py`

**Interfaces:**
- Produces:
  ```python
  GET /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&resource&scope=mcp&state
     -> 302 to f"{web_app_url}/oauth/consent?request={request_id}" with Set-Cookie: pw_oauth_req=<token_urlsafe(32)>; HttpOnly; Secure (when public_api_url is https); SameSite=Lax; Path=/oauth; Max-Age=600
     -> before a valid client+redirect: 400 text/html page (template string in app/oauth/pages.py) naming the error; never a redirect
     -> after a valid client+redirect but bad other params: 302 redirect_uri?error=invalid_request|invalid_scope|unsupported_response_type&error_description&state&iss
  GET /oauth/authorize/{request_id}  (Depends get_current_user)  -> ConsentView {client_name, client_uri, logo_uri, vendor: str|None, verified: bool, redirect_host: str, loopback: bool, scopes: ["mcp"], account_email: str, workspaces: [{id,name}], expires_at}
     404 request_not_found when missing/expired/decided
  POST /oauth/authorize/{request_id}/approve (get_current_user; Cookie pw_oauth_req) -> ConsentDecisionOut {redirect_to: str}
     403 browser_mismatch when cookie missing or sha256(cookie) != browser_binding_hash; 404 as above
     mints family_id (new_id), code raw=token_urlsafe(32), stores OAuthCode(code_hash, ..., expires_at=now+300s), marks request approved, puts OAuthFamily; redirect_to = redirect_uri + "?code=…&state=…&iss=<public_api_url>" (omit state when None)
  POST /oauth/authorize/{request_id}/deny  -> ConsentDecisionOut {redirect_to: redirect_uri?error=access_denied&state&iss}
  ```
  `GET /oauth/authorize` must not require auth. CORS for `/oauth/authorize/{id}` and the approve/deny routes is the existing global middleware (web origin, credentials allowed), which is what lets the cookie travel.

- [ ] **Step 1: Write failing tests**: happy path end to end up to the redirect URL (parse `code`, `state`, `iss`); each validation branch; Review Focus 3 (no cookie → 403; cookie from another request → 403); `resource` mismatch → redirect with `invalid_request`; `code_challenge_method=plain` → `invalid_request`; CIMD client resolved via a monkeypatched `fetch_client_metadata`; consent view shows `verified=True` for a Claude.ai redirect and `False` with `redirect_host` for an unknown HTTPS host; deny path; expired request → 404; approving twice → 404.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): OAuth authorize with browser-bound consent, approve and deny"
```

---

### Task 7: Token endpoint, refresh rotation, revocation, grants, sweep

**Files:**
- Modify: `apps/cloud/app/api/oauth.py`, `apps/cloud/app/oauth/tokens.py` (grant logic), `apps/cloud/app/api/me.py` (grants routes), `apps/cloud/app/main.py` (sweep loop), `apps/cloud/app/models/schemas.py` (`OAuthGrantOut`)
- Create: `apps/cloud/app/oauth/supabase_users.py`
- Test: `apps/cloud/tests/test_oauth_token.py`, `apps/cloud/tests/test_oauth_grants.py`

**Interfaces:**
- Produces:
  ```python
  POST /oauth/token  (application/x-www-form-urlencoded; Form fields)
     grant_type=authorization_code: code, redirect_uri, client_id, code_verifier, resource
       -> take_oauth_code(sha256(code)); verify client_id, redirect_uri, resource equal stored; base64url(sha256(code_verifier)) == code_challenge; not expired
       -> 200 {"access_token","token_type":"Bearer","expires_in":900,"refresh_token","scope":"mcp"}
       -> reuse (take returns None but get_oauth_code finds used_at set): revoke_oauth_family(code.family_id,"code_reuse"); 400 invalid_grant
     grant_type=refresh_token: refresh_token, client_id, resource?
       -> row by hash; revoked family or expired -> invalid_grant
       -> row already rotated (rotated_to_hash set): within 30 s of rotated_at, grace: return a fresh access token with NO refresh_token field (the client keeps whichever refresh token it holds; the raw successor is not stored so it cannot be re-sent); after 30 s -> revoke family "refresh_reuse", invalid_grant
       -> normal: supabase_users.user_is_active(user_id) (cached 300 s) else revoke family "user_inactive" + invalid_grant; rotate: new token, old.rotated_to_hash/rotated_at set; 200 as above
     errors: 400 {"error": "invalid_request"|"invalid_grant"|"unsupported_grant_type"|"invalid_client", "error_description"}; no CORS headers
  POST /oauth/revoke  (form: token, token_type_hint?) -> 200 {} always; revokes the family of a refresh token hash if found
  GET /me/oauth-grants -> list[OAuthGrantOut {family_id, client_id, client_name, vendor, verified, created_at, last_used_at, revoked_at}]
  DELETE /me/oauth-grants/{family_id} -> 204 (must belong to caller)
  DELETE /me/oauth-grants -> 204 (revoke all for caller)
  # supabase_users.py
  async def user_is_active(settings, user_id, *, http: httpx.AsyncClient, cache: dict, now=None) -> bool   # GET {supabase_url}/auth/v1/admin/users/{id} with apikey+Bearer service key; 404 or banned_until in future -> False; stub mode -> True
  # main.py
  async def _oauth_sweep_loop(app, settings)   # every oauth_sweep_interval_seconds: delete expired requests/codes/refresh tokens, purge dcr clients unused 90 days; same cancel pattern as _decision_sweep_loop
  ```
  `last_used_at` on the family is updated on each refresh and once per 5 minutes from `/mcp` (Task 8).

- [ ] **Step 1: Write failing tests**: full code→token flow using Task 6's routes; wrong verifier → `invalid_grant`; redirect/resource/client mismatch each → `invalid_grant`; expired code; code reuse revokes the family (second exchange `invalid_grant`, `get_oauth_family(...).revoked_at` set); refresh rotation issues a new refresh and old one in grace returns access only; Review Focus 4 part one (old token after 31 s → family revoked); inactive Supabase user (fake `user_is_active` False) → `invalid_grant` and family revoked; revoke endpoint; grants list/delete/delete-all with another user's family → 404; sweep deletes expired rows.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): OAuth token endpoint with PKCE, rotating refresh tokens, revocation and grant listing"
```

---

### Task 8: Mount the MCP server with task tools

**Files:**
- Create: `apps/cloud/app/mcp/__init__.py`, `apps/cloud/app/mcp/server.py`, `apps/cloud/app/mcp/auth.py`, `apps/cloud/app/mcp/tools_tasks.py`
- Modify: `apps/cloud/app/main.py` (mount + lifespan), `apps/cloud/app/api/me.py` (extract `assigned_tasks_for(repo, user, workspace_id, statuses, limit)` helper that also filters by current membership), `apps/cloud/app/api/sync.py` (extract `apply_task_status(repo, request_app, project, user, task_id, body)` from `set_task_status` so the tool and the route share it)
- Test: `apps/cloud/tests/test_mcp_server.py`

**Interfaces:**
- Produces:
  ```python
  # auth.py
  class PromptWorkspaceTokenVerifier(TokenVerifier):
      def __init__(self, settings, keys, repo, *, family_cache_ttl=30.0): ...
      async def verify_token(self, token: str) -> AccessToken | None   # verify_access_token; then family not revoked (cache 30 s by family_id); returns AccessToken(token=token, client_id=claims.client_id, scopes=["mcp"], expires_at=int, resource=canonical_mcp_url, subject=claims.sub, claims={"email":..., "fid":...})
  def current_user() -> User     # from mcp.server.auth.middleware.auth_context.get_access_token(); raises ToolError("not_authenticated") if None
  # server.py
  def build_mcp_server(settings, repo_provider: Callable[[], Repository], keys) -> MCPServer   # name "promptworkspace", instructions text, token_verifier, auth=AuthSettings(issuer_url=public_api_url, resource_server_url=canonical_mcp_url, required_scopes=["mcp"], validate_token_resource=True)
  def build_mcp_asgi(server, settings) -> Starlette   # server.streamable_http_app(streamable_http_path="/", transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=[host of public_api_url, "localhost:*", "127.0.0.1:*"], allowed_origins=settings.cors_origin_list), session_idle_timeout=1800)
  # main.py: app.mount("/mcp", mcp_asgi) when mcp_enabled, with redirect_slashes=False on the FastAPI app for that path (FastAPI(redirect_slashes=False) and an explicit route for "/mcp" that forwards to the sub-app); lifespan wraps `async with server.session_manager.run():`
  # tools_tasks.py (registered on the server with @server.tool())
  list_my_tasks(workspace_id: str | None = None, status: list[str] | None = None) -> list[dict]
  get_task(task_id: str) -> dict          # title, ref, branch_name, commit_prefix, status, project, workspace, repo_url, acceptance_criteria, spec_excerpt (4000 chars), constitution_present: bool, how_to_close
  close_task(task_id: str, status: Literal["in_progress","implemented","verified"], commit_sha: str | None = None) -> dict   # commit_sha required when status == "implemented"
  ```
  The PRM served by the SDK inside the mounted app lands at `/mcp/.well-known/...`; Task 4's top-level PRM routes are the ones clients use, so pass `resource_server_url` correctly and verify the SDK's 401 header points at `/.well-known/oauth-protected-resource/mcp` on the API origin (override by setting `AuthSettings.resource_server_url` to the canonical URL; the SDK computes the metadata URL from it).

- [ ] **Step 1: Write failing tests** using `mcp.client.streamable_http.streamablehttp_client` against `httpx.ASGITransport(app)` (the SDK client accepts an `httpx_client_factory`): unauthenticated POST → 401 with `WWW-Authenticate` containing `resource_metadata="https://api.test/.well-known/oauth-protected-resource/mcp"`; Review Focus 5 (Supabase-shaped token → 401; token with `aud` of another host → 401); valid token → `list_tools` returns the six names (three planning tools are added in Task 9, so this task asserts the three task tools and the test is extended later); `list_my_tasks` returns only tasks in workspaces the user is still a member of (remove membership, task still assigned → not listed); `close_task(status="implemented")` without `commit_sha` → tool error; with sha → task status implemented and artifact recorded; `get_task` spec excerpt truncated at 4000; Review Focus 4 part two (revoke the family → next call 401 after cache expiry, use `family_cache_ttl=0` in the test); `GET /mcp` and `GET /mcp/` both answer without a 307; a request with `Origin: https://evil.example` → 403.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**. Tool handlers: `user = current_user()`; `repo = repo_provider()` (service role); call the shared helpers from `me.py` and `sync.py` which run `require_project` and the status rules; map `HTTPException` to `ToolError(f"{detail}: <one sentence>")` with a small detail→sentence table (`not_a_member`, `status_forbidden`, `verified_requires_admin`, `task_not_found`).

- [ ] **Step 4: Run the whole cloud suite and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): hosted MCP at /mcp with bearer verification and the task tools"
```

---

### Task 9: Planning tools and repo URL resolution

**Files:**
- Create: `apps/cloud/app/mcp/tools_planning.py`, `apps/cloud/app/mcp/repo_url.py`, `docs/contracts/repo-url-cases.json`
- Modify: `apps/cloud/app/api/stage_drafts.py` and `apps/cloud/app/api/repo_analysis.py` (extract `planning_brief_for(repo, project, user)`, `submit_agent_analysis_for(repo, project, user, body)`, `submit_stage_draft_for(repo, project, user, body)` so routes and tools share them), `packages/cloud-client/test/repoUrl.test.ts` (also read the shared cases file)
- Test: `apps/cloud/tests/test_mcp_planning_tools.py`, `apps/cloud/tests/test_repo_url.py`

**Interfaces:**
- Produces:
  ```python
  # repo_url.py (port of packages/cloud-client/src/repoUrl.ts normalizeRepoUrl + sameRepo, same rules incl. host alias hyphen suffix)
  def normalize_repo_url(raw: str) -> str | None
  def same_repo(a: str, b: str) -> bool
  def resolve_project(repo, user, *, project_id: str | None, repo_url: str | None) -> Project   # project_id wins; else match repo_url against every project in the caller's workspaces; 0 -> ToolError("no_project_for_repo: <url>"); 2+ -> ToolError("ambiguous_repo: <names>")
  # tools_planning.py
  start_planning(project_id: str | None = None, repo_url: str | None = None) -> str   # Markdown brief as the stdio tool renders it, plus a line telling the agent to read AGENTS.md, docs/conventions.md and .specify/memory/constitution.md from its clone
  submit_repo_analysis(project_id=None, repo_url=None, *, default_branch, commit_sha, paths, file_count, tree_truncated=False, stack=None, tree_summary="", baseline, model=None) -> str
  submit_stage_draft(project_id=None, repo_url=None, *, stage, markdown, model=None) -> str   # includes warnings bullets exactly as apps/mcp/src/planning.ts renders them
  ```
  `docs/contracts/repo-url-cases.json`: `[{"a": "...", "b": "...", "same": true|false}, ...]` covering ssh scp form, https with `.git`, trailing slash, case, credentials, port, host alias hyphen suffix. Both the TS test and the Python test read it.

- [ ] **Step 1: Write failing tests**: `normalize_repo_url` and `same_repo` over the shared cases; `resolve_project` by id, by URL, ambiguous, none; each planning tool round trip against the in-memory backend through the MCP client (imported project fixture from `tests/test_repo_analysis_api.py`); 403 from `require_admin` surfaces as a tool error naming the stage/role; `list_tools` now returns six names.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement; update the TS test to load the shared cases file (keep its existing cases too)**

- [ ] **Step 4: Run cloud suite + lint, and `pnpm --dir packages/cloud-client test`, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): hosted planning tools with shared repo URL matching"
```

---

### Task 10: Web: safeNext, consent page, connected agents, connect snippets

**Files:**
- Modify: `apps/web/src/lib/next-path.ts`, `apps/web/next.config.ts` (headers for `/oauth/consent`), `apps/web/src/lib/api.ts` (`getConsent`, `approveConsent`, `denyConsent`, `listOauthGrants`, `revokeOauthGrant`, `revokeAllOauthGrants`), `apps/web/src/lib/types.ts`, `apps/web/src/components/project/AgentPlanningChecklist.tsx` (step 1 copy), `apps/web/src/app/w/[workspaceId]/settings/page.tsx` (a "Connect your coding agent" card)
- Create: `apps/web/src/app/oauth/consent/page.tsx`, `apps/web/src/app/account/agents/page.tsx`, `apps/web/src/components/ConnectSnippets.tsx`
- Test: `apps/web/src/lib/next-path.test.ts`, `apps/web/src/app/oauth/consent/page.test.tsx`, `apps/web/src/app/account/agents/page.test.tsx`, `apps/web/src/components/ConnectSnippets.test.tsx`, `AgentPlanningChecklist.test.tsx` (update)

**Interfaces:**
- Produces:
  ```ts
  export function safeNext(raw: string | null): string   // "/" unless raw matches /^\/(?![\/\\])/ and contains no "\\" and no ":" before the first "/" segment
  // consent page: reads ?request=, RequireAuth (login returns via ?next=/oauth/consent?request=…), GET consent view with credentials: "include", renders: verified badge or "Unverified — redirects to <host>" first line, client name/logo, scopes sentence, workspaces list, account email, Approve/Deny; on approve navigates to redirect_to (window.location.assign)
  // ConnectSnippets props { apiUrl: string }: Claude Code command, Cursor deeplink (cursor://anysphere.cursor-deeplink/mcp/install?name=promptworkspace&config=<base64 {"url": apiUrl+"/mcp"}>) and JSON, "Custom connector URL" for Claude.ai / ChatGPT; copy buttons
  // account/agents page: table of grants with Revoke, "Revoke all"
  // reset-password page: after a successful reset calls revokeAllOauthGrants(); the TopBar "Sign out everywhere" (if present) does the same, else add the call to the existing sign-out handler behind a confirm
  // checklist step 1 copy: "Connect your coding agent to PromptWorkspace" with the Claude Code command (from NEXT_PUBLIC_CLOUD_API_URL) and a link "Other agents" to the workspace settings card
  ```
  `next.config.ts` `headers()` returns for `/oauth/consent`: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`.

- [ ] **Step 1: Write failing tests**: reset-password success triggers `DELETE /me/oauth-grants`; `safeNext` rejects `//evil`, `/\evil`, `/\\evil`, `javascript:` and accepts `/w/x`, `/oauth/consent?request=1`; consent page renders verified and unverified variants, approve calls the API with `credentials: "include"` and navigates; agents page lists and revokes; snippets render the three forms with the API URL; checklist step 1 shows the new copy and no longer mentions `promptworkspace-mcp login`.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**

- [ ] **Step 4: `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): OAuth consent page, connected agents, connect snippets; harden safeNext"
```

---

### Task 11: stdio package demotion, npm publish workflow, docs and ADR

**Files:**
- Create: `.github/workflows/mcp-publish.yml`, `docs/decisions/0029-cloud-is-its-own-oauth-authorization-server.md`
- Modify: `apps/mcp/README.md` (reframe as CI/offline fallback; hosted URL first), `apps/mcp/package.json` (`name: "@promptconnext/promptworkspace-mcp"`, `publishConfig.access: public`, `bin`), `CLAUDE.md` (lines ~27, ~36, ~60, ~86), `docs/plans/0025-mcp-server.md` (status line; M4 paragraph amended: delivered as hosted HTTP + OAuth, device code dropped), `docs/DEPLOYMENT.md` (§2.4 env vars `MCP_ENABLED`, `MCP_OAUTH_SIGNING_KEY`, `MCP_OAUTH_PREVIOUS_SIGNING_KEY`, `FORWARDED_ALLOW_IPS`, `OAUTH_SWEEP_INTERVAL_SECONDS`; key generation command `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`; §2.2 migration 0013 apply-before-deploy; §8 trust settings; Supabase redirect allow-list entry `{WEB_APP_URL}/oauth/consent*`; note that Northflank SSE idle timeout is to be measured), the design doc's "Calls" list if anything changed

- [ ] **Step 1: Write the ADR** (Status Accepted, date 2026-10-25): context (hosted MCP needs audience-bound tokens; Supabase OAuth beta limits; spec forbids passthrough), decision (cloud is the AS; one scope; consent every time; tokens in Postgres), consequences (new tables and keys to operate; key rotation procedure; stdio demoted).

- [ ] **Step 2: Make the doc and package edits; the publish workflow triggers on tags `mcp-v*`, runs `pnpm install --frozen-lockfile`, `pnpm --dir apps/mcp build && test`, then `npm publish --provenance --access public` with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`**

- [ ] **Step 3: Grep for stale claims**

Run: `grep -rn "stdio transport only\|HTTP is a later milestone\|device-code\|promptworkspace-mcp login" CLAUDE.md docs/plans/0025-mcp-server.md apps/mcp/README.md apps/web/src`
Expected: hits only in historical sentences of the 0025 amendment and the README's CI/offline section.

- [ ] **Step 4: Commit**

```bash
git commit -am "docs: ADR 0029 cloud as OAuth authorization server; hosted MCP docs, env and npm publish workflow"
```

---

### Task 12: Whole-branch verification and trust rollout notes

- [ ] **Step 1: Run every suite**

```bash
cd apps/cloud && .venv/bin/pytest -q && .venv/bin/ruff check . && cd ../..
pnpm --dir packages/cloud-client test
pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp test
pnpm --dir apps/web typecheck && pnpm --dir apps/web test
```

- [ ] **Step 2: End-to-end against the in-memory cloud with a real OAuth client**

Start `MCP_ENABLED=1 MCP_OAUTH_SIGNING_KEY="$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt)" PUBLIC_API_URL=http://localhost:8080 WEB_APP_URL=http://localhost:3000 DATA_BACKEND=memory AUTH_MODE=stub uvicorn app.main:app --port 8080`. Script (Python, `mcp` SDK client with its `OAuthClientProvider`, loopback redirect server on a random port): discover → register via DCR → open authorize URL → simulate consent by calling `GET /oauth/authorize/{id}` and `POST …/approve` with `X-User-Id: alice` and the `pw_oauth_req` cookie captured from the 302 → exchange code → `list_tools` → `list_my_tasks`. Then `claude mcp add --transport http pw-local http://localhost:8080/mcp` and complete the flow in a real browser against the stub web app if `pnpm web` is running; record what each step returned.

- [ ] **Step 3: Placeholder grep**

Run: `git diff origin/feature/trust-outcome...HEAD | grep -nE "TODO|FIXME|test\.skip|\.only\(|NotImplementedError"`
Expected: none.

- [ ] **Step 4: Write the trust rollout checklist into the task report** (not executed by the implementer): generate and set `MCP_OAUTH_SIGNING_KEY`, `MCP_ENABLED=true`, `FORWARDED_ALLOW_IPS` on `promptworkspace-trust`; apply migration 0013; add `https://promptworkspace-trust.truthledgers.com/oauth/consent*` to the trust Supabase redirect allow-list; redeploy; run `claude mcp add --transport http promptworkspace https://promptworkspace-trust-api.truthledgers.com/mcp`; then Cursor and Claude.ai; record protocol revision each client used (SDK logs) and the Northflank SSE idle timeout observed.
