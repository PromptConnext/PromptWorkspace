"""Access-token issue/verify and refresh-token generation."""

from __future__ import annotations

import hashlib
import secrets
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt
from cryptography.hazmat.primitives import serialization

from app.oauth.keys import SigningKey


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
        "iss": settings.public_api_url,
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
    settings, keys: Iterable[SigningKey], token: str, *, now: datetime | None = None
) -> AccessClaims:
    try:
        kid = jwt.get_unverified_header(token).get("kid")
    except jwt.PyJWTError as err:
        raise TokenError("malformed") from err
    key = next((k for k in keys if kid and k.kid == kid), None)
    if key is None:
        raise TokenError("malformed")
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
            issuer=settings.public_api_url,
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
