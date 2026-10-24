"""OAuth 2.1 authorization-server discovery metadata and JWKS."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.oauth.keys import jwks, load_signing_keys

router = APIRouter(tags=["oauth"])

_CACHE = {"Cache-Control": "public, max-age=300"}


def _json(body: dict) -> JSONResponse:
    return JSONResponse(body, headers=_CACHE)


def _issuer(request: Request) -> str:
    return get_settings().public_api_url.rstrip("/")


def _as_metadata(issuer: str) -> dict:
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/oauth/authorize",
        "token_endpoint": f"{issuer}/oauth/token",
        "registration_endpoint": f"{issuer}/oauth/register",
        "revocation_endpoint": f"{issuer}/oauth/revoke",
        "jwks_uri": f"{issuer}/oauth/jwks.json",
        "code_challenge_methods_supported": ["S256"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "response_types_supported": ["code"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/oauth-authorization-server/mcp")
def authorization_server_metadata(request: Request) -> JSONResponse:
    return _json(_as_metadata(_issuer(request)))


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource_metadata(request: Request) -> JSONResponse:
    settings = get_settings()
    return _json(
        {
            "resource": settings.canonical_mcp_url,
            "authorization_servers": [_issuer(request)],
            "scopes_supported": ["mcp"],
            "bearer_methods_supported": ["header"],
        }
    )


@router.get("/oauth/jwks.json")
def jwks_document(request: Request) -> JSONResponse:
    current, previous = load_signing_keys(get_settings())
    return _json(jwks([k for k in (current, previous) if k is not None]))
