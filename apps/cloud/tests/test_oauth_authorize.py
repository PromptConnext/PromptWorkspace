"""`GET /oauth/authorize`, the consent read, approve and deny.

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
"Cloud: the authorization server". No browser-binding cookie (2026-10-25
ruling): approve and deny need only the Supabase bearer."""

from __future__ import annotations

import base64
import hashlib
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.models.schemas import OAuthClient, utcnow
from app.oauth import cimd

ISS = "https://api.test"
RESOURCE = "https://api.test/mcp"
WEB = "https://web.test"
ALICE = {"X-User-Id": "alice"}
VERIFIER = "v" * 64
_DIGEST = hashlib.sha256(VERIFIER.encode()).digest()
CHALLENGE = base64.urlsafe_b64encode(_DIGEST).rstrip(b"=").decode()


def _pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _env(monkeypatch):
    monkeypatch.setenv("MCP_ENABLED", "1")
    monkeypatch.setenv("MCP_OAUTH_SIGNING_KEY", _pem())
    monkeypatch.setenv("PUBLIC_API_URL", "https://api.test/")
    monkeypatch.setenv("WEB_APP_URL", WEB)


@pytest.fixture
def client(monkeypatch):
    _env(monkeypatch)
    get_settings.cache_clear()
    with TestClient(create_app(), follow_redirects=False) as c:
        yield c
    get_settings.cache_clear()


def _register(client, uris=("https://app.example/cb",), name="Some App") -> str:
    r = client.post("/oauth/register", json={"redirect_uris": list(uris), "client_name": name})
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


def _prereg(client, cid="claude-pre", uris=("https://claude.ai/api/mcp/auth_callback",)):
    client.app.state.repository.upsert_oauth_client(
        OAuthClient(
            client_id=cid,
            kind="preregistered",
            client_name="Claude",
            redirect_uris=list(uris),
            created_at=utcnow(),
        )
    )
    return cid


def _params(cid, redirect="https://app.example/cb", **over):
    p = {
        "response_type": "code",
        "client_id": cid,
        "redirect_uri": redirect,
        "code_challenge": CHALLENGE,
        "code_challenge_method": "S256",
        "resource": RESOURCE,
        "scope": "mcp",
        "state": "st-123 /+=",
    }
    p.update(over)
    return {k: v for k, v in p.items() if v is not None}


def _authorize(client, cid, redirect="https://app.example/cb", **over):
    return client.get("/oauth/authorize", params=_params(cid, redirect, **over))


def _request_id(resp) -> str:
    assert resp.status_code == 302, resp.text
    loc = urlsplit(resp.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{WEB}/oauth/consent"
    return parse_qs(loc.query)["request"][0]


def _q(url: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlsplit(url).query, keep_blank_values=True).items()}


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #


def test_happy_path_end_to_end(client):
    cid = _register(client)
    r = _authorize(client, cid)
    assert "set-cookie" not in r.headers
    rid = _request_id(r)

    view = client.get(f"/oauth/authorize/{rid}", headers=ALICE)
    assert view.status_code == 200, view.text
    v = view.json()
    assert v["client_name"] == "Some App"
    assert v["verified"] is False and v["vendor"] is None
    assert v["redirect_host"] == "app.example"
    assert v["loopback"] is False
    assert v["scopes"] == ["mcp"]
    assert v["account_email"] == "alice@promptworkspace.local"
    assert isinstance(v["workspaces"], list)
    assert v["expires_at"]

    a = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    assert a.status_code == 200, a.text
    to = a.json()["redirect_to"]
    assert to.startswith("https://app.example/cb?")
    q = _q(to)
    assert q["state"] == "st-123 /+="
    assert q["iss"] == ISS
    code = q["code"]
    assert len(code) >= 40

    repo = client.app.state.repository
    stored = repo.get_oauth_code(hashlib.sha256(code.encode()).hexdigest())
    assert stored is not None
    assert stored.user_id == "alice"
    assert stored.client_id == cid
    assert stored.redirect_uri == "https://app.example/cb"
    assert stored.code_challenge == CHALLENGE
    assert stored.resource == RESOURCE
    assert stored.scope == "mcp"
    assert stored.request_id == rid
    left = (stored.expires_at - utcnow()).total_seconds()
    assert 280 < left <= 300
    fam = repo.get_oauth_family(stored.family_id)
    assert fam is not None and fam.user_id == "alice" and fam.client_id == cid
    req = repo.get_oauth_request(rid)
    assert req.approved_user_id == "alice" and req.approved_at is not None
    assert repo.get_oauth_client(cid).last_used_at is not None


CURSOR_NATIVE = "cursor://anysphere.cursor-mcp/oauth/callback"
CURSOR_URIS = (
    CURSOR_NATIVE,
    "https://www.cursor.com/agents/mcp/oauth/callback",
    "http://localhost:8787/callback",
)


def test_cursor_native_callback_end_to_end(client):
    cid = _register(client, uris=CURSOR_URIS, name="Cursor")
    rid = _request_id(_authorize(client, cid, redirect=CURSOR_NATIVE))
    v = client.get(f"/oauth/authorize/{rid}", headers=ALICE).json()
    assert v["vendor"] == "Cursor" and v["verified"] is True
    a = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    assert a.status_code == 200, a.text
    to = a.json()["redirect_to"]
    assert to.startswith(CURSOR_NATIVE + "?")
    assert _q(to)["code"]


def test_cursor_evil_callback_refused(client):
    cid = _register(client, uris=CURSOR_URIS, name="Cursor")
    r = _authorize(client, cid, redirect="cursor://evil/callback")
    _assert_html_400(r, "invalid_redirect_uri")


def test_request_expires_in_ten_minutes(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    req = client.app.state.repository.get_oauth_request(rid)
    assert abs((req.expires_at - req.created_at).total_seconds() - 600) < 1


def test_existing_query_preserved_and_state_omitted(client):
    cid = _register(client, uris=("https://app.example/cb?tenant=a",))
    rid = _request_id(_authorize(client, cid, "https://app.example/cb?tenant=a", state=None))
    to = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE).json()["redirect_to"]
    q = _q(to)
    assert q["tenant"] == "a"
    assert "state" not in q
    assert q["iss"] == ISS and q["code"]


def test_loopback_any_port(client):
    cid = _register(client, uris=("http://127.0.0.1/callback",))
    rid = _request_id(_authorize(client, cid, "http://127.0.0.1:53123/callback"))
    v = client.get(f"/oauth/authorize/{rid}", headers=ALICE).json()
    assert v["loopback"] is True and v["verified"] is True and v["vendor"] is None
    to = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE).json()["redirect_to"]
    assert to.startswith("http://127.0.0.1:53123/callback?")


def test_scope_defaults_to_mcp_when_empty(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid, scope=None))
    assert client.app.state.repository.get_oauth_request(rid).scope == "mcp"


# --------------------------------------------------------------------------- #
# Consent view: verified / unverified
# --------------------------------------------------------------------------- #


def test_consent_view_verified_for_claude(client):
    cid = _prereg(client)
    rid = _request_id(_authorize(client, cid, "https://claude.ai/api/mcp/auth_callback"))
    v = client.get(f"/oauth/authorize/{rid}", headers=ALICE).json()
    assert v["vendor"] == "Claude" and v["verified"] is True
    assert v["redirect_host"] == "claude.ai"


def test_consent_view_lists_user_workspaces(client):
    ws = client.post("/workspaces", json={"name": "Alpha"}, headers=ALICE)
    assert ws.status_code in (200, 201), ws.text
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    v = client.get(f"/oauth/authorize/{rid}", headers=ALICE).json()
    assert {"id": ws.json()["id"], "name": "Alpha"} in v["workspaces"]


def test_consent_view_unknown_404(client):
    r = client.get("/oauth/authorize/nope", headers=ALICE)
    assert r.status_code == 404 and r.json()["detail"] == "request_not_found"


# --------------------------------------------------------------------------- #
# Errors before a valid client + redirect: HTML 400, never a redirect
# --------------------------------------------------------------------------- #


def _assert_html_400(r, code):
    assert r.status_code == 400
    assert "location" not in r.headers
    assert r.headers["content-type"].startswith("text/html")
    assert code in r.text


def test_unknown_client_html(client):
    _assert_html_400(_authorize(client, "no-such-client"), "invalid_client")


def test_missing_client_id_html(client):
    _assert_html_400(_authorize(client, None), "invalid_client")


def test_redirect_mismatch_html(client):
    cid = _register(client)
    _assert_html_400(_authorize(client, cid, "https://evil.example/cb"), "invalid_redirect_uri")


def test_redirect_mismatch_html_even_with_other_errors(client):
    cid = _register(client)
    r = _authorize(client, cid, "https://evil.example/cb", response_type="token")
    _assert_html_400(r, "invalid_redirect_uri")


def test_missing_redirect_html(client):
    cid = _register(client)
    _assert_html_400(_authorize(client, cid, None), "invalid_redirect_uri")


def test_html_escapes_nothing_user_controlled(client):
    r = _authorize(client, "<script>alert(1)</script>")
    assert r.status_code == 400 and "<script>" not in r.text


# --------------------------------------------------------------------------- #
# Errors after a valid client + redirect: 302 to redirect_uri with error
# --------------------------------------------------------------------------- #


def _assert_error_redirect(r, error, state="st-123 /+="):
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://app.example/cb?")
    q = _q(loc)
    assert q["error"] == error
    assert q["error_description"]
    assert q["iss"] == ISS
    if state is None:
        assert "state" not in q
    else:
        assert q["state"] == state


@pytest.mark.parametrize(
    "over,error",
    [
        ({"response_type": "token"}, "unsupported_response_type"),
        ({"response_type": None}, "unsupported_response_type"),
        ({"code_challenge_method": "plain"}, "invalid_request"),
        ({"code_challenge_method": None}, "invalid_request"),
        ({"code_challenge": None}, "invalid_request"),
        ({"code_challenge": "short"}, "invalid_request"),
        ({"code_challenge": "a" * 129}, "invalid_request"),
        ({"code_challenge": "a" * 42 + "!"}, "invalid_request"),
        ({"resource": "https://other.test/mcp"}, "invalid_request"),
        ({"resource": None}, "invalid_request"),
        ({"resource": RESOURCE + "/"}, "invalid_request"),
        ({"scope": "mcp admin"}, "invalid_scope"),
        ({"scope": "openid"}, "invalid_scope"),
    ],
)
def test_param_errors_redirect(client, over, error):
    cid = _register(client)
    r = _authorize(client, cid, **over)
    _assert_error_redirect(r, error)
    assert client.app.state.repository._oauth_requests == {}


def test_error_redirect_without_state(client):
    cid = _register(client)
    r = _authorize(client, cid, state=None, code_challenge_method="plain")
    _assert_error_redirect(r, "invalid_request", state=None)


def test_authorize_needs_no_auth(client):
    cid = _register(client)
    r = client.get("/oauth/authorize", params=_params(cid))
    assert r.status_code == 302


# --------------------------------------------------------------------------- #
# CIMD clients
# --------------------------------------------------------------------------- #


CIMD_ID = "https://client.example/meta.json"


def test_cimd_client_resolved(client, monkeypatch):
    calls = []

    async def fake_fetch(client_id, **kw):
        calls.append(client_id)
        return OAuthClient(
            client_id=client_id,
            kind="cimd",
            client_name="Cimd App",
            redirect_uris=["https://client.example/cb"],
            metadata={"client_id": client_id},
            created_at=utcnow(),
        )

    monkeypatch.setattr(cimd, "fetch_client_metadata", fake_fetch)
    rid = _request_id(_authorize(client, CIMD_ID, "https://client.example/cb"))
    assert calls == [CIMD_ID]
    stored = client.app.state.repository.get_oauth_client(CIMD_ID)
    assert stored.kind == "cimd" and stored.metadata.get("fetched_at")
    v = client.get(f"/oauth/authorize/{rid}", headers=ALICE).json()
    assert v["client_name"] == "Cimd App" and v["redirect_host"] == "client.example"

    # Fresh row: no refetch.
    _request_id(_authorize(client, CIMD_ID, "https://client.example/cb"))
    assert calls == [CIMD_ID]

    # Stale row (> 1 h): refetched.
    repo = client.app.state.repository
    stale = repo.get_oauth_client(CIMD_ID)
    stale.metadata["fetched_at"] = (utcnow() - timedelta(seconds=3601)).isoformat()
    repo.upsert_oauth_client(stale)
    _request_id(_authorize(client, CIMD_ID, "https://client.example/cb"))
    assert calls == [CIMD_ID, CIMD_ID]


def test_cimd_document_cannot_forge_fetched_at(client, monkeypatch):
    async def fake_fetch(client_id, **kw):
        return OAuthClient(
            client_id=client_id,
            kind="cimd",
            redirect_uris=["https://client.example/cb"],
            metadata={"client_id": client_id, "fetched_at": "2999-01-01T00:00:00+00:00"},
            created_at=utcnow(),
        )

    monkeypatch.setattr(cimd, "fetch_client_metadata", fake_fetch)
    _request_id(_authorize(client, CIMD_ID, "https://client.example/cb"))
    got = client.app.state.repository.get_oauth_client(CIMD_ID).metadata["fetched_at"]
    assert not got.startswith("2999")


def test_cimd_fetch_failure_html(client, monkeypatch):
    async def fake_fetch(client_id, **kw):
        raise cimd.CimdError("private_address", "10.0.0.1")

    monkeypatch.setattr(cimd, "fetch_client_metadata", fake_fetch)
    _assert_html_400(_authorize(client, CIMD_ID, "https://client.example/cb"), "invalid_client")


def test_cimd_redirect_not_listed_html(client, monkeypatch):
    async def fake_fetch(client_id, **kw):
        return OAuthClient(
            client_id=client_id,
            kind="cimd",
            redirect_uris=["https://client.example/cb"],
            created_at=utcnow(),
        )

    monkeypatch.setattr(cimd, "fetch_client_metadata", fake_fetch)
    _assert_html_400(
        _authorize(client, CIMD_ID, "https://attacker.example/cb"), "invalid_redirect_uri"
    )


# --------------------------------------------------------------------------- #
# Approve / deny state machine (Review Focus 3)
# --------------------------------------------------------------------------- #


def test_approve_twice_409(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    assert client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE).status_code == 200
    r = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    assert r.status_code == 409 and r.json()["detail"] == "request_decided"
    r = client.post(f"/oauth/authorize/{rid}/deny", headers=ALICE)
    assert r.status_code == 409 and r.json()["detail"] == "request_decided"


def test_decided_view_404(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    r = client.get(f"/oauth/authorize/{rid}", headers=ALICE)
    assert r.status_code == 404 and r.json()["detail"] == "request_not_found"


def test_deny(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    r = client.post(f"/oauth/authorize/{rid}/deny", headers=ALICE)
    assert r.status_code == 200
    q = _q(r.json()["redirect_to"])
    assert r.json()["redirect_to"].startswith("https://app.example/cb?")
    assert q == {"error": "access_denied", "state": "st-123 /+=", "iss": ISS}
    repo = client.app.state.repository
    assert repo.get_oauth_request(rid).denied_at is not None
    assert repo._oauth_codes == {}
    assert client.get(f"/oauth/authorize/{rid}", headers=ALICE).status_code == 404
    r = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    assert r.status_code == 409


def test_expired_request_404(client):
    cid = _register(client)
    rid = _request_id(_authorize(client, cid))
    repo = client.app.state.repository
    req = repo.get_oauth_request(rid)
    req.expires_at = utcnow() - timedelta(seconds=1)
    repo.update_oauth_request(req)
    for r in (
        client.get(f"/oauth/authorize/{rid}", headers=ALICE),
        client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE),
        client.post(f"/oauth/authorize/{rid}/deny", headers=ALICE),
    ):
        assert r.status_code == 404 and r.json()["detail"] == "request_not_found"
    assert repo._oauth_codes == {}


def test_approve_unknown_404(client):
    r = client.post("/oauth/authorize/nope/approve", headers=ALICE)
    assert r.status_code == 404 and r.json()["detail"] == "request_not_found"


def test_approve_without_bearer_401(monkeypatch):
    _env(monkeypatch)
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "x")
    get_settings.cache_clear()
    try:
        with TestClient(create_app(), follow_redirects=False) as c:
            cid = _register(c)
            rid = _request_id(_authorize(c, cid))
            assert c.post(f"/oauth/authorize/{rid}/approve").status_code == 401
            assert c.post(f"/oauth/authorize/{rid}/deny").status_code == 401
            assert c.get(f"/oauth/authorize/{rid}").status_code == 401
            assert c.app.state.repository.get_oauth_request(rid).approved_at is None
    finally:
        get_settings.cache_clear()


def test_absent_when_disabled(monkeypatch):
    get_settings.cache_clear()
    with TestClient(create_app(), follow_redirects=False) as c:
        assert c.get("/oauth/authorize").status_code == 404
