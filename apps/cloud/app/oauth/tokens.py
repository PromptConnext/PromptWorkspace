"""Access-token issue/verify, refresh-token generation, and the token
endpoint's two grants (authorization_code with PKCE, rotating refresh_token)
plus the periodic sweep of expired OAuth rows.

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
"/oauth/token" and "Tokens". Nothing here logs or returns a raw code or
token; only their SHA-256 hashes are stored."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization

from app.models.schemas import OAuthRefreshToken
from app.oauth.keys import SigningKey

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AccessClaims:
    sub: str
    email: str
    client_id: str
    family_id: str
    scope: str
    jti: str
    exp: datetime
    aud: str = ""


class TokenError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def issue_access_token(
    settings,
    key: SigningKey,
    *,
    sub: str,
    email: str,
    client_id: str,
    family_id: str,
    scope: str = "mcp",
    now: datetime | None = None,
) -> tuple[str, AccessClaims]:
    now = now or datetime.now(timezone.utc)
    exp = now + timedelta(seconds=settings.mcp_access_token_ttl_seconds)
    jti = secrets.token_urlsafe(16)
    aud = settings.canonical_mcp_url
    payload = {
        "iss": settings.oauth_issuer,
        "sub": sub,
        "aud": aud,
        "client_id": client_id,
        "fid": family_id,
        "scope": scope,
        "email": email,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
        "jti": jti,
    }
    token = jwt.encode(payload, key.private_pem, algorithm="ES256", headers={"kid": key.kid})
    claims = AccessClaims(
        sub=sub, email=email, client_id=client_id, family_id=family_id,
        scope=scope, jti=jti, exp=exp, aud=aud,
    )  # fmt: skip
    return token, claims


def verify_access_token(
    settings,
    keys: Iterable[SigningKey],
    token: str,
    *,
    now: datetime | None = None,
    public_keys: dict[str, Any] | None = None,
) -> AccessClaims:
    """`public_keys` (kid -> parsed public key) lets a hot caller such as the
    /mcp verifier skip re-parsing the PEM on every call."""
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as err:
        raise TokenError("malformed") from err
    key = next((k for k in keys if kid and k.kid == kid), None)
    if key is None:
        raise TokenError("malformed")
    public = (public_keys or {}).get(key.kid)
    if public is None:
        public = serialization.load_pem_private_key(key.private_pem.encode(), None).public_key()
    options = {"require": ["exp", "iss", "aud", "sub"]}
    if now is not None:
        # PyJWT checks exp against wall clock; honour an injected clock ourselves.
        options["verify_exp"] = False
    try:
        data = jwt.decode(
            token,
            public,
            algorithms=["ES256"],
            audience=settings.canonical_mcp_url,
            issuer=settings.oauth_issuer,
            options=options,
        )
    except jwt.InvalidAudienceError as err:
        raise TokenError("wrong_audience") from err
    except jwt.InvalidIssuerError as err:
        raise TokenError("wrong_issuer") from err
    except jwt.ExpiredSignatureError as err:
        raise TokenError("expired") from err
    except jwt.InvalidSignatureError as err:
        raise TokenError("invalid_signature") from err
    except jwt.PyJWTError as err:
        raise TokenError("malformed") from err
    exp = datetime.fromtimestamp(data["exp"], tz=timezone.utc)
    if now is not None and exp <= now:
        raise TokenError("expired")
    return AccessClaims(
        sub=data["sub"],
        email=data.get("email", ""),
        client_id=data.get("client_id", ""),
        family_id=data.get("fid", ""),
        scope=data.get("scope", ""),
        jti=data.get("jti", ""),
        exp=exp,
        aud=data["aud"] if isinstance(data["aud"], str) else settings.canonical_mcp_url,
    )


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_refresh_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(48)
    return raw, hash_token(raw)


# --------------------------------------------------------------------------- #
# Grants
# --------------------------------------------------------------------------- #

# A rotated refresh token presented again within this window is a parallel
# refresh by the same client, not theft: it gets an access token and a fresh
# successor refresh token in the same family.
REFRESH_GRACE = timedelta(seconds=30)
DCR_UNUSED = timedelta(days=90)
# Bump the client's last_used_at (what keeps a DCR client from the 90-day
# purge) at most this often from the token endpoint.
_CLIENT_TOUCH = timedelta(hours=1)
# RFC 7636 §4.1: 43-128 characters from the unreserved set.
_VERIFIER = re.compile(r"[A-Za-z0-9\-._~]{43,128}")


class GrantError(Exception):
    """An RFC 6749 §5.2 error. `description` never carries a code or token."""

    def __init__(self, error: str, description: str):
        super().__init__(error)
        self.error = error
        self.description = description


# user_id -> supabase_users.UserRecord
Lookup = Callable[[str], Awaitable[Any]]


def pkce_matches(verifier: str, challenge: str) -> bool:
    if not _VERIFIER.fullmatch(verifier):
        return False
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    computed = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return hmac.compare_digest(computed.encode(), challenge.encode())


def _touch_client(repo, client, now: datetime) -> None:
    if client.last_used_at is None or now - client.last_used_at >= _CLIENT_TOUCH:
        repo.touch_oauth_client(client.client_id, now)


def _bookkeep(repo, client, family_id: str, now: datetime) -> None:
    """last_used_at on the family and the client. Best-effort: by now a code is
    burned or a refresh token rotated, so failing the response here would
    strand the client's new tokens (and a rotated token replayed after the
    grace window revokes the family)."""
    try:
        repo.touch_oauth_family(family_id, now)
    except Exception as err:  # noqa: BLE001 - bookkeeping must not fail the grant
        logger.warning("OAuth family touch failed (%s)", type(err).__name__)
    try:
        _touch_client(repo, client, now)
    except Exception as err:  # noqa: BLE001 - bookkeeping must not fail the grant
        logger.warning("OAuth client touch failed (%s)", type(err).__name__)


def _access(settings, key, *, sub, email, client_id, family_id, scope, now) -> dict:
    token, _ = issue_access_token(
        settings, key, sub=sub, email=email, client_id=client_id,
        family_id=family_id, scope=scope, now=now,
    )  # fmt: skip
    return {
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": settings.mcp_access_token_ttl_seconds,
        "scope": scope,
    }


def _put_refresh(repo, settings, digest, *, family_id, client_id, user_id, scope, resource, now):
    repo.put_refresh_token(
        OAuthRefreshToken(
            token_hash=digest, family_id=family_id, client_id=client_id, user_id=user_id,
            scope=scope, resource=resource, issued_at=now,
            expires_at=now + timedelta(days=settings.mcp_refresh_token_ttl_days),
        )
    )  # fmt: skip


def _live_family(repo, family_id: str):
    fam = repo.get_oauth_family(family_id)
    if fam is None or fam.revoked_at is not None:
        raise GrantError("invalid_grant", "the grant has been revoked")
    return fam


async def exchange_code(
    repo,
    settings,
    key: SigningKey,
    *,
    client,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    resource: str | None,
    now: datetime,
    lookup: Lookup,
) -> dict:
    """authorization_code grant. The code is burned before anything else is
    checked, so a failed attempt cannot be retried with other parameters."""
    code_hash = hash_token(code)
    row = repo.take_oauth_code(code_hash, now)
    if row is None:
        seen = repo.get_oauth_code(code_hash)
        if seen is not None and seen.used_at is not None:
            # RFC 6749 §4.1.2: a reused code revokes what it issued.
            repo.revoke_oauth_family(seen.family_id, "code_reuse", now)
        raise GrantError("invalid_grant", "authorization code is invalid or already used")
    if row.expires_at <= now:
        raise GrantError("invalid_grant", "authorization code has expired")
    if row.client_id != client.client_id:
        raise GrantError("invalid_grant", "authorization code was issued to another client")
    if redirect_uri != row.redirect_uri:
        raise GrantError("invalid_grant", "redirect_uri does not match the authorization request")
    if resource is not None and resource != row.resource:
        raise GrantError("invalid_grant", "resource does not match the authorization request")
    if not pkce_matches(code_verifier, row.code_challenge):
        raise GrantError("invalid_grant", "code_verifier does not match the code_challenge")
    _live_family(repo, row.family_id)
    user = await lookup(row.user_id)
    if not user.active:
        repo.revoke_oauth_family(row.family_id, "user_inactive", now)
        raise GrantError("invalid_grant", "the account is no longer active")

    body = _access(
        settings, key, sub=row.user_id, email=user.email, client_id=row.client_id,
        family_id=row.family_id, scope=row.scope, now=now,
    )  # fmt: skip
    raw, digest = new_refresh_token()
    _put_refresh(
        repo, settings, digest, family_id=row.family_id, client_id=row.client_id,
        user_id=row.user_id, scope=row.scope, resource=row.resource, now=now,
    )  # fmt: skip
    body["refresh_token"] = raw
    _bookkeep(repo, client, row.family_id, now)
    return body


async def refresh_grant(
    repo,
    settings,
    key: SigningKey,
    *,
    client,
    refresh_token: str,
    resource: str | None,
    now: datetime,
    lookup: Lookup,
) -> dict:
    """refresh_token grant with rotation on every use and a 30 s grace for a
    just-rotated token. Within the grace a replay receives a fresh successor
    in the same family (its first successor's raw value is not stored, so it
    cannot be re-sent). The old row's `rotated_to_hash` keeps pointing at the
    first successor, both successors are live, and the original replayed
    after the window still revokes the family. Returning no refresh token
    here would strand SDK clients: they keep the already-rotated token and
    their next refresh, after the window, would revoke the family."""
    row = repo.get_refresh_token(hash_token(refresh_token))
    if row is None:
        raise GrantError("invalid_grant", "refresh token is invalid")
    if row.client_id != client.client_id:
        raise GrantError("invalid_grant", "refresh token was issued to another client")
    if resource is not None and resource != row.resource:
        raise GrantError("invalid_grant", "resource does not match the grant")
    _live_family(repo, row.family_id)
    if row.revoked_at is not None or row.expires_at <= now:
        raise GrantError("invalid_grant", "refresh token has expired or been revoked")

    rotated = row.rotated_to_hash is not None
    if not rotated:
        user = await lookup(row.user_id)
        if not user.active:
            repo.revoke_oauth_family(row.family_id, "user_inactive", now)
            raise GrantError("invalid_grant", "the account is no longer active")
        # Everything that can fail is built before the claim: once the old
        # token is rotated, the new one must reach the client.
        body = _access(
            settings, key, sub=row.user_id, email=user.email, client_id=row.client_id,
            family_id=row.family_id, scope=row.scope, now=now,
        )  # fmt: skip
        new_raw, new_hash = new_refresh_token()
        if repo.claim_refresh_rotation(row.token_hash, new_hash, now):
            _put_refresh(
                repo, settings, new_hash, family_id=row.family_id, client_id=row.client_id,
                user_id=row.user_id, scope=row.scope, resource=row.resource, now=now,
            )  # fmt: skip
            body["refresh_token"] = new_raw
            _bookkeep(repo, client, row.family_id, now)
            return body
        # Lost a race with a parallel refresh: fall through to the grace rule.
        row = repo.get_refresh_token(row.token_hash)
        if row is None or row.rotated_at is None:
            raise GrantError("invalid_grant", "refresh token is invalid")

    if row.rotated_at is not None and now - row.rotated_at <= REFRESH_GRACE:
        user = await lookup(row.user_id)
        if not user.active:
            repo.revoke_oauth_family(row.family_id, "user_inactive", now)
            raise GrantError("invalid_grant", "the account is no longer active")
        body = _access(
            settings, key, sub=row.user_id, email=user.email, client_id=row.client_id,
            family_id=row.family_id, scope=row.scope, now=now,
        )  # fmt: skip
        new_raw, new_hash = new_refresh_token()
        _put_refresh(
            repo, settings, new_hash, family_id=row.family_id, client_id=row.client_id,
            user_id=row.user_id, scope=row.scope, resource=row.resource, now=now,
        )  # fmt: skip
        body["refresh_token"] = new_raw
        _bookkeep(repo, client, row.family_id, now)
        return body
    # A rotated token replayed after the grace window: assume theft.
    repo.revoke_oauth_family(row.family_id, "refresh_reuse", now)
    raise GrantError("invalid_grant", "refresh token has already been used")


def revoke_refresh(repo, token: str, client_id: str | None, now: datetime) -> None:
    """RFC 7009: revoke the family of a refresh token, if it is one and (when
    the caller names a client) was issued to that client. Silent otherwise."""
    row = repo.get_refresh_token(hash_token(token))
    if row is None:
        return
    if client_id is not None and client_id != row.client_id:
        return
    repo.revoke_oauth_family(row.family_id, "client_revoke", now)


def sweep_oauth(repo, now: datetime) -> dict[str, int]:
    """Delete expired requests, codes and refresh tokens, and DCR clients
    unused for 90 days. Families are kept: they are the grant history."""
    return {
        "requests": repo.delete_oauth_requests_expired(now),
        "codes": repo.delete_oauth_codes_expired(now),
        "refresh_tokens": repo.delete_refresh_tokens_expired(now),
        "clients": repo.delete_oauth_clients_unused_since(now - DCR_UNUSED, kind="dcr"),
    }
