"""ES256 signing keys for the hosted MCP authorization server."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


@dataclass(frozen=True)
class SigningKey:
    kid: str
    private_pem: str
    public_jwk: dict


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _coord(n: int) -> str:
    return _b64u(n.to_bytes(32, "big"))


def _jwk(public_key: ec.EllipticCurvePublicKey) -> dict:
    nums = public_key.public_numbers()
    return {"kty": "EC", "crv": "P-256", "x": _coord(nums.x), "y": _coord(nums.y)}


def kid_for(public_key: ec.EllipticCurvePublicKey) -> str:
    """RFC 7638 JWK thumbprint (SHA-256), base64url without padding."""
    canon = json.dumps(_jwk(public_key), separators=(",", ":"), sort_keys=True)
    return _b64u(hashlib.sha256(canon.encode()).digest())


def _load(pem: str) -> SigningKey:
    private = serialization.load_pem_private_key(pem.encode(), password=None)
    if not isinstance(private, ec.EllipticCurvePrivateKey) or not isinstance(
        private.curve, ec.SECP256R1
    ):
        raise ValueError("MCP signing key must be an EC P-256 private key")
    public = private.public_key()
    kid = kid_for(public)
    return SigningKey(
        kid=kid,
        private_pem=pem,
        public_jwk={**_jwk(public), "kid": kid, "alg": "ES256", "use": "sig"},
    )


def load_signing_keys(settings) -> tuple[SigningKey, SigningKey | None]:
    current = _load(settings.mcp_oauth_signing_key)
    previous = (
        _load(settings.mcp_oauth_previous_signing_key)
        if settings.mcp_oauth_previous_signing_key
        else None
    )
    return current, previous


def jwks(keys: Iterable[SigningKey]) -> dict:
    return {"keys": [dict(k.public_jwk) for k in keys]}
