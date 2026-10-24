"""OAuth 2.1 authorization server: discovery metadata, JWKS, dynamic client
registration (RFC 7591), the authorization endpoint with its consent read,
approve and deny, and the token (RFC 6749 §3.2) and revocation (RFC 7009)
endpoints."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from datetime import timedelta
from urllib.parse import urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import ValidationError

from app.config import get_settings
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    ConsentDecisionOut,
    ConsentView,
    ConsentWorkspace,
    DcrRegistrationIn,
    DcrRegistrationOut,
    OAuthClient,
    OAuthCode,
    OAuthFamily,
    OAuthRequest,
    new_id,
    utcnow,
)
from app.oauth import cimd, supabase_users
from app.oauth.clients import (
    RedirectError,
    UnknownClient,
    is_loopback,
    redirect_uri_allowed,
    resolve_client,
    validate_redirect_uri,
)
from app.oauth.keys import jwks, load_signing_keys
from app.oauth.known_clients import classify
from app.oauth.pages import error_page
from app.oauth.tokens import GrantError, exchange_code, refresh_grant, revoke_refresh

router = APIRouter(tags=["oauth"])

_CACHE = {"Cache-Control": "public, max-age=300"}


def _json(body: dict) -> JSONResponse:
    return JSONResponse(body, headers=_CACHE)


def _issuer(request: Request) -> str:
    return get_settings().oauth_issuer


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
    # Size cap before parsing: the body is buffered and json.loads is
    # unbounded otherwise. The declared length is checked, then the stream is
    # counted as it arrives, since Content-Length may be absent or wrong.
    too_big = f"body larger than {DcrRegistrationIn.MAX_BODY} bytes"
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > DcrRegistrationIn.MAX_BODY:
        return _dcr_error("invalid_client_metadata", too_big)
    raw = bytearray()
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > DcrRegistrationIn.MAX_BODY:
            return _dcr_error("invalid_client_metadata", too_big)
    try:
        body = json.loads(raw)
    except (ValueError, RecursionError):
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


# --------------------------------------------------------------------------- #
# Authorization endpoint, consent read, approve and deny
# --------------------------------------------------------------------------- #

REQUEST_TTL = timedelta(seconds=600)
CODE_TTL = timedelta(seconds=300)
_SCOPE = "mcp"
# RFC 7636 §4.2: an S256 challenge is base64url, 43 to 128 characters.
_CHALLENGE = re.compile(r"[A-Za-z0-9_-]{43,128}")


def _with_query(redirect_uri: str, params: dict[str, str | None]) -> str:
    """`redirect_uri` with `params` appended (None values omitted), keeping
    any query the registered URI already carries."""
    parts = urlsplit(redirect_uri)
    extra = urlencode({k: v for k, v in params.items() if v is not None})
    query = f"{parts.query}&{extra}" if parts.query else extra
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def _cimd_fetch(request: Request):
    cache = getattr(request.app.state, "cimd_cache", None)
    if cache is None:
        cache = request.app.state.cimd_cache = {}

    async def fetch(client_id: str) -> OAuthClient:
        # Looked up on the module each call so tests can monkeypatch it.
        return await cimd.fetch_client_metadata(client_id, cache=cache)

    return fetch


def _single(request: Request, name: str) -> str | None:
    """The parameter's value, or None when absent or repeated."""
    values = request.query_params.getlist(name)
    return values[0] if len(values) == 1 else None


@router.get("/oauth/authorize")
async def authorize(request: Request):
    settings = get_settings()
    repo = request.app.state.repository  # pw_oauth_* are service-only
    q = request.query_params

    # 1. Client and redirect URI. Until both are valid there is nowhere safe
    #    to redirect to: render an HTML error instead.
    client_id = _single(request, "client_id")
    if not client_id:
        return error_page("invalid_client")
    try:
        client = await resolve_client(repo, client_id, cimd_fetch=_cimd_fetch(request))
    except (UnknownClient, cimd.CimdError):
        return error_page("invalid_client")
    candidate = _single(request, "redirect_uri")
    if not candidate:
        return error_page("invalid_redirect_uri")
    try:
        validate_redirect_uri(candidate, client.redirect_uris)
    except RedirectError:
        return error_page("invalid_redirect_uri")
    # Redirect to what the client sent (it matched a registered URI; loopback
    # may differ only in port).
    redirect_uri = candidate
    state = q.get("state")
    issuer = _issuer(request)

    def fail(error: str, description: str) -> RedirectResponse:
        return RedirectResponse(
            _with_query(
                redirect_uri,
                {
                    "error": error,
                    "error_description": description,
                    "state": state,
                    "iss": issuer,
                },
            ),
            status_code=302,
            headers=_NO_STORE,
        )

    # 2. Everything else is reported to the client.
    if _single(request, "response_type") != "code":
        return fail("unsupported_response_type", "response_type must be code")
    if _single(request, "code_challenge_method") != "S256":
        return fail("invalid_request", "code_challenge_method must be S256")
    challenge = _single(request, "code_challenge")
    if not challenge or not _CHALLENGE.fullmatch(challenge):
        return fail("invalid_request", "code_challenge must be 43-128 base64url characters")
    if _single(request, "resource") != settings.canonical_mcp_url:
        return fail("invalid_request", f"resource must be {settings.canonical_mcp_url}")
    if len(q.getlist("state")) > 1:
        return fail("invalid_request", "state must not repeat")
    scopes = q.getlist("scope")
    if len(scopes) > 1:
        return fail("invalid_request", "scope must not repeat")
    scope = (scopes[0] if scopes else "").strip()
    if scope not in ("", _SCOPE):
        return fail("invalid_scope", "the only supported scope is mcp")

    now = utcnow()
    stored = repo.put_oauth_request(
        OAuthRequest(
            client_id=client.client_id,
            redirect_uri=redirect_uri,
            code_challenge=challenge,
            resource=settings.canonical_mcp_url,
            scope=_SCOPE,
            state=state,
            created_at=now,
            expires_at=now + REQUEST_TTL,
        )
    )
    consent = f"{settings.web_app_url.rstrip('/')}/oauth/consent?" + urlencode(
        {"request": stored.request_id}
    )
    return RedirectResponse(consent, status_code=302, headers=_NO_STORE)


def _pending(repo, request_id: str) -> OAuthRequest:
    """The request if it exists and has not expired; 404 otherwise. Whether it
    is already decided is the caller's question. A non-UUID id is a 404
    without a read (the column is uuid; it would be a database error)."""
    try:
        request_id = str(uuid.UUID(request_id))
    except ValueError:
        raise HTTPException(status_code=404, detail="request_not_found") from None
    req = repo.get_oauth_request(request_id)
    if req is None or req.expires_at <= utcnow():
        raise HTTPException(status_code=404, detail="request_not_found")
    return req


def _decided(req: OAuthRequest) -> bool:
    return req.approved_at is not None or req.denied_at is not None


@router.get("/oauth/authorize/{request_id}", response_model=ConsentView)
def consent_view(
    request_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    user_repo: Repository = Depends(get_repository),
) -> ConsentView:
    repo = request.app.state.repository
    req = _pending(repo, request_id)
    if _decided(req):
        raise HTTPException(status_code=404, detail="request_not_found")
    client = repo.get_oauth_client(req.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="request_not_found")
    vendor, verified = classify(client.redirect_uris)
    loopback = is_loopback(req.redirect_uri)
    if vendor == "loopback":
        vendor, verified, loopback = None, True, True
    workspaces = user_repo.list_workspaces(user_id=user.id)
    return ConsentView(
        client_name=client.client_name,
        client_uri=client.client_uri,
        logo_uri=client.logo_uri,
        vendor=vendor,
        verified=verified,
        redirect_host=urlsplit(req.redirect_uri).hostname or "",
        loopback=loopback,
        scopes=[_SCOPE],
        account_email=user.email,
        workspaces=[ConsentWorkspace(id=w.id, name=w.name) for w in workspaces],
        expires_at=req.expires_at,
    )


def _undecided(repo, request_id: str) -> OAuthRequest:
    req = _pending(repo, request_id)
    if _decided(req):
        raise HTTPException(status_code=409, detail="request_decided")
    return req


@router.post("/oauth/authorize/{request_id}/approve", response_model=ConsentDecisionOut)
def approve(
    request_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> JSONResponse:
    repo = request.app.state.repository
    req = _undecided(repo, request_id)
    now = utcnow()
    family_id = new_id()
    code = secrets.token_urlsafe(32)
    repo.put_oauth_family(
        OAuthFamily(family_id=family_id, client_id=req.client_id, user_id=user.id)
    )
    repo.put_oauth_code(
        OAuthCode(
            code_hash=hashlib.sha256(code.encode()).hexdigest(),
            request_id=req.request_id,
            family_id=family_id,
            client_id=req.client_id,
            user_id=user.id,
            redirect_uri=req.redirect_uri,
            code_challenge=req.code_challenge,
            resource=req.resource,
            scope=req.scope,
            expires_at=now + CODE_TTL,
        )
    )
    req.approved_user_id = user.id
    req.approved_at = now
    repo.update_oauth_request(req)
    client = repo.get_oauth_client(req.client_id)
    if client is not None:
        client.last_used_at = now
        repo.upsert_oauth_client(client)
    out = ConsentDecisionOut(
        redirect_to=_with_query(
            req.redirect_uri, {"code": code, "state": req.state, "iss": _issuer(request)}
        )
    )
    return JSONResponse(out.model_dump(), headers=_NO_STORE)


@router.post("/oauth/authorize/{request_id}/deny", response_model=ConsentDecisionOut)
def deny(
    request_id: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> JSONResponse:
    repo = request.app.state.repository
    req = _undecided(repo, request_id)
    req.denied_at = utcnow()
    repo.update_oauth_request(req)
    out = ConsentDecisionOut(
        redirect_to=_with_query(
            req.redirect_uri,
            {"error": "access_denied", "state": req.state, "iss": _issuer(request)},
        )
    )
    return JSONResponse(out.model_dump(), headers=_NO_STORE)


# --------------------------------------------------------------------------- #
# Token and revocation endpoints
# --------------------------------------------------------------------------- #

_TOKEN_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_FORM = "application/x-www-form-urlencoded"


def _now(request: Request):
    """The request's clock; tests inject `app.state.oauth_clock`."""
    return getattr(request.app.state, "oauth_clock", utcnow)()


def _token_error(error: str, description: str) -> JSONResponse:
    return JSONResponse(
        {"error": error, "error_description": description},
        status_code=400,
        headers=_TOKEN_HEADERS,
    )


async def _form(request: Request) -> dict[str, list[str]] | None:
    """The urlencoded body as name -> values, or None when it is not one."""
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype != _FORM:
        return None
    form = await request.form()
    return {k: [v for v in form.getlist(k) if isinstance(v, str)] for k in form.keys()}


class _Missing(Exception):
    def __init__(self, description: str):
        self.description = description


def _field(form: dict[str, list[str]], name: str, *, required: bool) -> str | None:
    values = form.get(name, [])
    if len(values) > 1:
        raise _Missing(f"{name} must not repeat")
    value = values[0] if values else None
    if required and not value:
        raise _Missing(f"{name} is required")
    return value or None


def _lookup(request: Request, settings):
    cache = getattr(request.app.state, "oauth_user_cache", None)
    if cache is None:
        cache = request.app.state.oauth_user_cache = {}
    http = getattr(request.app.state, "oauth_http", None)

    async def lookup(user_id: str):
        # Looked up on the module each call so tests can monkeypatch it.
        return await supabase_users.lookup_user(
            settings, user_id, http=http, cache=cache, now=_now(request)
        )

    return lookup


@router.post("/oauth/token")
async def token(request: Request) -> JSONResponse:
    settings = get_settings()
    repo = request.app.state.repository  # pw_oauth_* are service-only
    form = await _form(request)
    if form is None:
        return _token_error("invalid_request", f"the body must be {_FORM}")
    try:
        grant_type = _field(form, "grant_type", required=True)
        if grant_type not in ("authorization_code", "refresh_token"):
            return _token_error(
                "unsupported_grant_type",
                "grant_type must be authorization_code or refresh_token",
            )
        client_id = _field(form, "client_id", required=True)
        resource = _field(form, "resource", required=False)
        if grant_type == "authorization_code":
            args = {
                "code": _field(form, "code", required=True),
                "redirect_uri": _field(form, "redirect_uri", required=True),
                "code_verifier": _field(form, "code_verifier", required=True),
            }
        else:
            args = {"refresh_token": _field(form, "refresh_token", required=True)}
    except _Missing as err:
        return _token_error("invalid_request", err.description)

    client = repo.get_oauth_client(client_id)
    if client is None:
        return _token_error("invalid_client", "unknown client_id")
    key, _ = load_signing_keys(settings)
    grant = exchange_code if grant_type == "authorization_code" else refresh_grant
    try:
        body = await grant(
            repo, settings, key, client=client, resource=resource,
            now=_now(request), lookup=_lookup(request, settings), **args,
        )  # fmt: skip
    except GrantError as err:
        return _token_error(err.error, err.description)
    return JSONResponse(body, headers=_TOKEN_HEADERS)


@router.post("/oauth/revoke")
async def revoke(request: Request) -> JSONResponse:
    """RFC 7009: always 200, whether or not the token was known."""
    form = await _form(request) or {}
    tokens = form.get("token", [])
    client_ids = form.get("client_id", [])
    if len(tokens) == 1 and tokens[0] and len(client_ids) <= 1:
        revoke_refresh(
            request.app.state.repository,
            tokens[0],
            client_ids[0] if client_ids else None,
            _now(request),
        )
    return JSONResponse({}, headers=_TOKEN_HEADERS)
