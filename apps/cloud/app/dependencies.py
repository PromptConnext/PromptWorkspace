"""FastAPI dependencies: current user (stub or JWT) and repository accessor.

Two auth modes (see Settings.auth_mode):
  * "stub"     — identity from an `X-User-Id` header (default; tests/local dev).
                 Swap users freely to exercise multi-user behaviour.
  * "supabase" — verify a real Supabase bearer JWT (aud="authenticated") on
                 every request; identity comes from the `sub` claim.

JWT verification tries two mechanisms, because Supabase Auth (gotrue) now
issues **asymmetric** ES256/RS256 tokens signed by per-project keys by
default — the legacy shared "JWT secret" (HS256) is a fallback only kept
for older/self-hosted projects still on that scheme. Verified directly
against a real local Supabase instance while building this (see
docs/plans/0004): a fresh `supabase start` issues ES256 tokens that the
previous HS256-only check rejected outright (401 on a genuinely valid
token) — that was a real bug, not a hypothetical one.
  1. JWKS (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) — current default.
  2. HS256 with `SUPABASE_JWT_SECRET` — legacy fallback, only tried if
     configured and JWKS verification didn't succeed.

Authorization (workspace membership / admin) lives in `app/api/_guards.py` so
it can be reused across routers.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Header, HTTPException, Request

from app.config import Settings
from app.db.repository import Repository


@dataclass
class User:
    id: str
    email: str


# PyJWKClient caches fetched keys internally; one client per Supabase URL is
# enough for the process lifetime (URLs don't change at runtime).
@lru_cache
def _jwks_client(jwks_url: str) -> jwt.PyJWKClient:
    return jwt.PyJWKClient(jwks_url)


def _verify_jwt(token: str, settings: Settings) -> dict:
    last_error: Exception | None = None

    if settings.supabase_url:
        jwks_url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        try:
            signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
            )
        except jwt.PyJWTError as err:
            last_error = err

    if settings.supabase_jwt_secret:
        try:
            return jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )
        except jwt.PyJWTError as err:
            last_error = err

    raise last_error or jwt.PyJWTError("no verification method configured")


def get_current_user(
    request: Request,
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
) -> User:
    settings = request.app.state.settings
    if settings.auth_mode == "stub":
        uid = x_user_id or "dev-user"
        return User(id=uid, email=f"{uid}@promptzone.local")

    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="missing_token")
    try:
        claims = _verify_jwt(token, settings)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid_token") from None
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="invalid_token")
    return User(id=sub, email=claims.get("email", ""))


def get_repository(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Repository:
    """The shared repository, scoped to the caller's own JWT when running in
    supabase auth mode — so RLS applies per request (defense in depth behind
    the app-layer membership guards in app/api/_guards.py).

    Un-authenticated call sites (inbound tracker webhooks, the tombstone GC
    loop) have no end-user token and correctly fall through to the shared,
    unscoped repository — those need the base SUPABASE_KEY's own privileges
    (a service-role key), not any particular user's RLS-narrowed view.
    """
    repo = request.app.state.repository
    settings = request.app.state.settings
    if settings.auth_mode == "supabase" and hasattr(repo, "for_user"):
        token = (authorization or "").removeprefix("Bearer ").strip()
        if token:
            return repo.for_user(token)
    return repo
