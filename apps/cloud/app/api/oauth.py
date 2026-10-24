"""OAuth 2.1 authorization server: discovery metadata, JWKS and dynamic client
registration (RFC 7591)."""

from __future__ import annotations

import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.config import get_settings
from app.models.schemas import (
    DcrRegistrationIn,
    DcrRegistrationOut,
    OAuthClient,
    new_id,
    utcnow,
)
from app.oauth.clients import redirect_uri_allowed
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


_GRANT_TYPES = ["authorization_code", "refresh_token"]
_RESPONSE_TYPES = ["code"]
_NO_STORE = {"Cache-Control": "no-store"}


def _dcr_error(error: str, description: str) -> JSONResponse:
    """RFC 7591 §3.2.2 error response; never FastAPI's 422."""
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=400,
        headers=_NO_STORE,
    )


def _validation_error(exc: ValidationError) -> JSONResponse:
    first = exc.errors()[0]
    loc = first.get("loc", ())
    field = ".".join(str(p) for p in loc) or "body"
    # A malformed URI inside redirect_uris (loc ("redirect_uris", i)) is a
    # redirect error; a wrong count or any other field is client metadata.
    if len(loc) >= 2 and loc[0] == "redirect_uris":
        return _dcr_error("invalid_redirect_uri", f"{field}: {first.get('msg', 'invalid')}")
    return _dcr_error("invalid_client_metadata", f"{field}: {first.get('msg', 'invalid')}")


@router.post("/oauth/register", status_code=201, response_model=DcrRegistrationOut)
async def register_client(request: Request):
    try:
        body = json.loads(await request.body())
    except ValueError:
        return _dcr_error("invalid_client_metadata", "body must be a JSON object")
    if not isinstance(body, dict):
        return _dcr_error("invalid_client_metadata", "body must be a JSON object")
    if "redirect_uris" not in body:
        return _dcr_error("invalid_redirect_uri", "redirect_uris is required")
    try:
        meta = DcrRegistrationIn.model_validate(body)
    except ValidationError as exc:
        return _validation_error(exc)

    # The raw strings are stored, not pydantic's normalised URLs, so the exact
    # match at /oauth/authorize compares what the client will actually send.
    uris = [str(u) for u in body["redirect_uris"]]
    for uri in uris:
        if not redirect_uri_allowed(uri):
            return _dcr_error(
                "invalid_redirect_uri",
                f"{uri!r}: redirect URIs must be https, or http on localhost/127.0.0.1",
            )
    if meta.grant_types is not None and not set(meta.grant_types) <= set(_GRANT_TYPES):
        return _dcr_error("invalid_client_metadata", f"grant_types must be within {_GRANT_TYPES}")
    if meta.response_types is not None and not set(meta.response_types) <= set(
        _RESPONSE_TYPES
    ):
        return _dcr_error(
            "invalid_client_metadata", f"response_types must be within {_RESPONSE_TYPES}"
        )

    grant_types = meta.grant_types or list(_GRANT_TYPES)
    response_types = meta.response_types or list(_RESPONSE_TYPES)
    now = utcnow()
    client = OAuthClient(
        client_id=new_id(),
        kind="dcr",
        client_name=meta.client_name,
        redirect_uris=uris,
        client_uri=str(body["client_uri"]) if meta.client_uri else None,
        logo_uri=str(body["logo_uri"]) if meta.logo_uri else None,
        metadata={
            "application_type": meta.application_type,
            "grant_types": grant_types,
            "response_types": response_types,
            "scope": meta.scope,
        },
        created_at=now,
    )
    # Unauthenticated route: the shared service repository, never a
    # user-scoped one (pw_oauth_clients is service-only).
    request.app.state.repository.upsert_oauth_client(client)
    out = DcrRegistrationOut(
        client_id=client.client_id,
        client_id_issued_at=int(now.timestamp()),
        redirect_uris=uris,
        client_name=client.client_name,
        token_endpoint_auth_method="none",
        grant_types=grant_types,
        response_types=response_types,
    )
    return JSONResponse(out.model_dump(), status_code=201, headers=_NO_STORE)
