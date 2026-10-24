"""`POST /oauth/token` (authorization_code and refresh_token grants) and
`POST /oauth/revoke`, driven through the real authorize -> approve flow.

Design: docs/superpowers/specs/2026-10-24-hosted-mcp-oauth-design.md,
"/oauth/token", "/oauth/revoke", "Tokens"."""

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
from app.models.schemas import utcnow
from app.oauth import supabase_users
from app.oauth.keys import load_signing_keys
from app.oauth.tokens import hash_token, verify_access_token

RESOURCE = "https://api.test/mcp"
REDIRECT = "https://app.example/cb"
ALICE = {"X-User-Id": "alice"}
VERIFIER = "v" * 64
CHALLENGE = (
    base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
)


def _pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


class Clock:
    def __init__(self):
        self.now = utcnow()

    def __call__(self):
        return self.now

    def advance(self, seconds: float):
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock():
    return Clock()


def make_client(monkeypatch, clock):
    """App with MCP on, stub auth, and `clock` as the token endpoint's clock."""
    monkeypatch.setenv("MCP_ENABLED", "1")
    monkeypatch.setenv("MCP_OAUTH_SIGNING_KEY", _pem())
    monkeypatch.setenv("PUBLIC_API_URL", "https://api.test/")
    monkeypatch.setenv("WEB_APP_URL", "https://web.test")
    get_settings.cache_clear()
    with TestClient(create_app(), follow_redirects=False) as c:
        c.app.state.oauth_clock = clock
        yield c
    get_settings.cache_clear()


@pytest.fixture
def client(monkeypatch, clock):
    yield from make_client(monkeypatch, clock)


def _register(client) -> str:
    r = client.post("/oauth/register", json={"redirect_uris": [REDIRECT], "client_name": "App"})
    assert r.status_code == 201, r.text
    return r.json()["client_id"]


def _code(client, cid: str, user=ALICE) -> str:
    r = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": cid,
            "redirect_uri": REDIRECT,
            "code_challenge": CHALLENGE,
            "code_challenge_method": "S256",
            "resource": RESOURCE,
            "scope": "mcp",
            "state": "s",
        },
    )
    assert r.status_code == 302, r.text
    rid = parse_qs(urlsplit(r.headers["location"]).query)["request"][0]
    a = client.post(f"/oauth/authorize/{rid}/approve", headers=user)
    assert a.status_code == 200, a.text
    return parse_qs(urlsplit(a.json()["redirect_to"]).query)["code"][0]


def _exchange(client, cid, code, **over):
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT,
        "client_id": cid,
        "code_verifier": VERIFIER,
        "resource": RESOURCE,
    }
    form.update(over)
    return client.post("/oauth/token", data={k: v for k, v in form.items() if v is not None})


def _refresh(client, cid, rt, **over):
    form = {"grant_type": "refresh_token", "refresh_token": rt, "client_id": cid}
    form.update(over)
    return client.post("/oauth/token", data={k: v for k, v in form.items() if v is not None})


def _err(r, error: str, status: int = 400):
    assert r.status_code == status, r.text
    assert r.json()["error"] == error
    assert "error_description" in r.json()
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["pragma"] == "no-cache"


def _family_id(client, code: str) -> str:
    return client.app.state.repository.get_oauth_code(hash_token(code)).family_id


@pytest.fixture
def active(monkeypatch):
    """Every user active; flip `state["active"]` to deactivate."""
    state = {"active": True, "calls": 0}

    async def fake(settings, user_id, *, http, cache, now=None):
        state["calls"] += 1
        return supabase_users.UserRecord(active=state["active"], email="alice@example.com")

    monkeypatch.setattr(supabase_users, "lookup_user", fake)
    return state


# --------------------------------------------------------------------------- #
# authorization_code
# --------------------------------------------------------------------------- #


def test_code_exchange_issues_access_and_refresh(client, active):
    cid = _register(client)
    code = _code(client, cid)
    r = _exchange(client, cid, code)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["pragma"] == "no-cache"
    body = r.json()
    assert body["token_type"] == "Bearer"
    assert body["expires_in"] == 900
    assert body["scope"] == "mcp"
    assert set(body) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}

    settings = get_settings()
    claims = verify_access_token(settings, [load_signing_keys(settings)[0]], body["access_token"])
    fid = _family_id(client, code)
    assert claims.sub == "alice"
    assert claims.client_id == cid
    assert claims.family_id == fid
    assert claims.aud == RESOURCE
    assert claims.email == "alice@example.com"

    repo = client.app.state.repository
    row = repo.get_refresh_token(hash_token(body["refresh_token"]))
    assert row is not None
    assert (row.family_id, row.client_id, row.user_id) == (fid, cid, "alice")
    assert row.resource == RESOURCE and row.scope == "mcp"
    assert (row.expires_at - row.issued_at) == timedelta(days=60)
    assert repo.get_oauth_family(fid).last_used_at is not None


def test_resource_may_be_omitted_at_the_token_endpoint(client, active):
    cid = _register(client)
    r = _exchange(client, cid, _code(client, cid), resource=None)
    assert r.status_code == 200, r.text


@pytest.mark.parametrize(
    "over",
    [
        {"code_verifier": "w" * 64},
        {"code_verifier": "v" * 42},
        {"code_verifier": "v" * 129},
        {"redirect_uri": "https://app.example/cb/"},
        {"resource": "https://api.test/other"},
    ],
    ids=["wrong-verifier", "short-verifier", "long-verifier", "redirect", "resource"],
)
def test_code_mismatch_is_invalid_grant(client, active, over):
    cid = _register(client)
    _err(_exchange(client, cid, _code(client, cid), **over), "invalid_grant")


def test_code_for_another_client_is_invalid_grant(client, active):
    cid = _register(client)
    other = _register(client)
    _err(_exchange(client, other, _code(client, cid)), "invalid_grant")


def test_unknown_client_is_invalid_client(client, active):
    cid = _register(client)
    _err(_exchange(client, "no-such-client", _code(client, cid)), "invalid_client")


def test_unknown_code_is_invalid_grant(client, active):
    cid = _register(client)
    _err(_exchange(client, cid, "not-a-code"), "invalid_grant")


def test_expired_code_is_invalid_grant(client, active, clock):
    cid = _register(client)
    code = _code(client, cid)
    clock.advance(301)
    _err(_exchange(client, cid, code), "invalid_grant")


def test_code_reuse_revokes_the_family(client, active):
    cid = _register(client)
    code = _code(client, cid)
    first = _exchange(client, cid, code)
    assert first.status_code == 200
    _err(_exchange(client, cid, code), "invalid_grant")
    fam = client.app.state.repository.get_oauth_family(_family_id(client, code))
    assert fam.revoked_at is not None and fam.revoked_reason == "code_reuse"
    # The refresh token minted by the first exchange is dead with its family.
    _err(_refresh(client, cid, first.json()["refresh_token"]), "invalid_grant")


def test_inactive_user_cannot_exchange_a_code(client, active):
    cid = _register(client)
    code = _code(client, cid)
    active["active"] = False
    _err(_exchange(client, cid, code), "invalid_grant")
    fam = client.app.state.repository.get_oauth_family(_family_id(client, code))
    assert fam.revoked_reason == "user_inactive"


def test_request_errors(client, active):
    cid = _register(client)
    _err(client.post("/oauth/token", data={"grant_type": "password"}), "unsupported_grant_type")
    _err(client.post("/oauth/token", data={}), "invalid_request")
    _err(
        client.post("/oauth/token", json={"grant_type": "authorization_code"}),
        "invalid_request",
    )
    _err(_exchange(client, cid, _code(client, cid), code_verifier=None), "invalid_request")
    _err(_refresh(client, cid, None), "invalid_request")
    _err(
        client.post(
            "/oauth/token",
            content="grant_type=refresh_token&grant_type=refresh_token&refresh_token=x"
            f"&client_id={cid}",
            headers={"content-type": "application/x-www-form-urlencoded"},
        ),
        "invalid_request",
    )


def test_error_bodies_never_echo_the_code(client, active):
    cid = _register(client)
    code = _code(client, cid)
    r = _exchange(client, cid, code, code_verifier="w" * 64)
    assert code not in r.text and "w" * 64 not in r.text


# --------------------------------------------------------------------------- #
# refresh_token
# --------------------------------------------------------------------------- #


def _tokens(client, cid):
    code = _code(client, cid)
    r = _exchange(client, cid, code)
    assert r.status_code == 200, r.text
    return r.json(), _family_id(client, code)


def test_refresh_rotates(client, active, clock):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    clock.advance(60)
    r = _refresh(client, cid, first["refresh_token"], resource=RESOURCE)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert body["refresh_token"] != first["refresh_token"]
    assert body["token_type"] == "Bearer" and body["expires_in"] == 900

    repo = client.app.state.repository
    old = repo.get_refresh_token(hash_token(first["refresh_token"]))
    new = repo.get_refresh_token(hash_token(body["refresh_token"]))
    assert old.rotated_to_hash == new.token_hash
    assert old.rotated_at == clock.now and old.last_used_at == clock.now
    assert new.family_id == fid and new.expires_at == clock.now + timedelta(days=60)
    assert repo.get_oauth_family(fid).last_used_at == clock.now
    # The successor works in turn.
    clock.advance(60)
    assert _refresh(client, cid, body["refresh_token"]).status_code == 200


def test_rotated_token_within_grace_returns_access_only(client, active, clock):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    assert _refresh(client, cid, first["refresh_token"]).status_code == 200
    clock.advance(30)
    r = _refresh(client, cid, first["refresh_token"])
    assert r.status_code == 200, r.text
    assert "refresh_token" not in r.json()
    assert r.json()["access_token"]
    assert client.app.state.repository.get_oauth_family(fid).revoked_at is None


def test_rotated_token_after_grace_revokes_the_family(client, active, clock):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    second = _refresh(client, cid, first["refresh_token"]).json()
    clock.advance(31)
    _err(_refresh(client, cid, first["refresh_token"]), "invalid_grant")
    fam = client.app.state.repository.get_oauth_family(fid)
    assert fam.revoked_reason == "refresh_reuse"
    # The legitimate holder's successor dies with the family.
    _err(_refresh(client, cid, second["refresh_token"]), "invalid_grant")


def test_inactive_user_refresh_revokes_the_family(client, active):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    active["active"] = False
    _err(_refresh(client, cid, first["refresh_token"]), "invalid_grant")
    assert client.app.state.repository.get_oauth_family(fid).revoked_reason == "user_inactive"


def test_refresh_rejections(client, active, clock):
    cid = _register(client)
    other = _register(client)
    first, fid = _tokens(client, cid)
    _err(_refresh(client, cid, "unknown"), "invalid_grant")
    _err(_refresh(client, other, first["refresh_token"]), "invalid_grant")
    _err(_refresh(client, cid, first["refresh_token"], resource="https://x.test/mcp"),
         "invalid_grant")  # fmt: skip
    _err(_refresh(client, "no-such-client", first["refresh_token"]), "invalid_client")
    # None of those burned or revoked anything.
    assert client.app.state.repository.get_oauth_family(fid).revoked_at is None
    clock.advance(timedelta(days=60).total_seconds())
    _err(_refresh(client, cid, first["refresh_token"]), "invalid_grant")


def test_refresh_in_revoked_family_is_invalid_grant(client, active):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    client.app.state.repository.revoke_oauth_family(fid, "user_revoke", utcnow())
    _err(_refresh(client, cid, first["refresh_token"]), "invalid_grant")


# --------------------------------------------------------------------------- #
# revoke
# --------------------------------------------------------------------------- #


def test_revoke_refresh_token_revokes_the_family(client, active):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    r = client.post(
        "/oauth/revoke",
        data={"token": first["refresh_token"], "token_type_hint": "refresh_token"},
    )
    assert r.status_code == 200 and r.json() == {}
    assert r.headers["cache-control"] == "no-store"
    assert client.app.state.repository.get_oauth_family(fid).revoked_reason == "client_revoke"
    _err(_refresh(client, cid, first["refresh_token"]), "invalid_grant")


def test_revoke_unknown_or_missing_token_is_still_200(client, active):
    assert client.post("/oauth/revoke", data={"token": "nope"}).json() == {}
    assert client.post("/oauth/revoke", data={}).status_code == 200


def test_revoke_with_another_clients_id_does_nothing(client, active):
    cid = _register(client)
    other = _register(client)
    first, fid = _tokens(client, cid)
    r = client.post("/oauth/revoke", data={"token": first["refresh_token"], "client_id": other})
    assert r.status_code == 200
    assert client.app.state.repository.get_oauth_family(fid).revoked_at is None


# --------------------------------------------------------------------------- #
# supabase_users.user_is_active
# --------------------------------------------------------------------------- #


def _sb_settings(mode="supabase"):
    from types import SimpleNamespace

    return SimpleNamespace(auth_mode=mode, supabase_url="https://sb.test", supabase_key="svc")


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def _mock(handler):
    import httpx

    seen = []

    def wrapped(req):
        seen.append(req)
        return handler(req)

    return httpx.AsyncClient(transport=httpx.MockTransport(wrapped)), seen


def test_user_is_active_stub_mode_never_calls_out():
    import httpx

    http, seen = _mock(lambda r: httpx.Response(500))
    assert _run(supabase_users.user_is_active(_sb_settings("stub"), "u", http=http, cache={}))
    assert seen == []


@pytest.mark.parametrize(
    "status,body,expected",
    [
        (200, {"id": "u", "email": "u@x"}, True),
        (200, {"id": "u", "banned_until": "2000-01-01T00:00:00Z"}, True),
        (200, {"id": "u", "banned_until": "2999-01-01T00:00:00Z"}, False),
        (200, {"id": "u", "banned_until": "none"}, True),
        (404, {}, False),
        (500, {}, True),
    ],
)
def test_user_is_active_reads_the_admin_api(status, body, expected):
    import httpx

    http, seen = _mock(lambda r: httpx.Response(status, json=body))
    got = _run(supabase_users.user_is_active(_sb_settings(), "u-1", http=http, cache={}))
    assert got is expected
    req = seen[0]
    assert str(req.url) == "https://sb.test/auth/v1/admin/users/u-1"
    assert req.headers["apikey"] == "svc"
    assert req.headers["authorization"] == "Bearer svc"


def test_user_is_active_network_error_fails_open():
    import httpx

    def boom(req):
        raise httpx.ConnectError("down")

    http, _ = _mock(boom)
    assert _run(supabase_users.user_is_active(_sb_settings(), "u", http=http, cache={}))


def test_user_is_active_caches_definite_answers_for_300s():
    import httpx

    http, seen = _mock(lambda r: httpx.Response(404))
    cache: dict = {}
    t0 = utcnow()
    s = _sb_settings()
    assert not _run(supabase_users.user_is_active(s, "u", http=http, cache=cache, now=t0))
    t1 = t0 + timedelta(seconds=299)
    assert not _run(supabase_users.user_is_active(s, "u", http=http, cache=cache, now=t1))
    assert len(seen) == 1
    t2 = t0 + timedelta(seconds=301)
    _run(supabase_users.user_is_active(s, "u", http=http, cache=cache, now=t2))
    assert len(seen) == 2


def test_user_is_active_does_not_cache_infrastructure_errors():
    import httpx

    http, seen = _mock(lambda r: httpx.Response(503))
    cache: dict = {}
    s = _sb_settings()
    _run(supabase_users.user_is_active(s, "u", http=http, cache=cache))
    _run(supabase_users.user_is_active(s, "u", http=http, cache=cache))
    assert len(seen) == 2


# --------------------------------------------------------------------------- #
# Bookkeeping is best-effort; races; loopback ports
# --------------------------------------------------------------------------- #


def _age_client(repo, cid):
    """Last used two hours ago: past the hourly client-touch threshold."""
    c = repo.get_oauth_client(cid)
    c.last_used_at = utcnow() - timedelta(hours=2)
    repo.upsert_oauth_client(c)


def _boom(*a, **kw):
    raise RuntimeError("db blip")


def test_family_touch_failure_does_not_strand_a_rotated_refresh(client, active, monkeypatch):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    repo = client.app.state.repository
    monkeypatch.setattr(repo, "touch_oauth_family", _boom)
    r = _refresh(client, cid, first["refresh_token"])
    assert r.status_code == 200, r.text
    new = r.json()["refresh_token"]
    assert repo.get_refresh_token(hash_token(new)) is not None
    assert "db blip" not in r.text


def test_client_touch_failure_does_not_fail_the_code_grant(client, active, monkeypatch):
    cid = _register(client)
    code = _code(client, cid)
    repo = client.app.state.repository
    _age_client(repo, cid)
    monkeypatch.setattr(repo, "touch_oauth_client", _boom)
    r = _exchange(client, cid, code)
    assert r.status_code == 200, r.text
    assert r.json()["refresh_token"]


def test_client_touch_is_field_scoped(client, active, clock):
    cid = _register(client)
    code = _code(client, cid)
    _age_client(client.app.state.repository, cid)
    assert _exchange(client, cid, code).status_code == 200
    stored = client.app.state.repository.get_oauth_client(cid)
    assert stored.last_used_at == clock.now and stored.client_name == "App"


def test_lost_rotation_race_gets_a_grace_response(client, active, monkeypatch):
    cid = _register(client)
    first, fid = _tokens(client, cid)
    repo = client.app.state.repository
    real = repo.claim_refresh_rotation
    calls = []

    def lose_once(token_hash, to_hash, now):
        if not calls:
            calls.append(1)
            real(token_hash, "parallel-winner", now)  # the other request won
            return False
        return real(token_hash, to_hash, now)

    monkeypatch.setattr(repo, "claim_refresh_rotation", lose_once)
    r = _refresh(client, cid, first["refresh_token"])
    assert r.status_code == 200, r.text
    assert r.json()["access_token"] and "refresh_token" not in r.json()
    assert repo.get_oauth_family(fid).revoked_at is None


def test_loopback_redirect_port_must_match_exactly(client, active):
    r = client.post(
        "/oauth/register",
        json={"redirect_uris": ["http://127.0.0.1:5000/cb"], "client_name": "Local"},
    )
    assert r.status_code == 201, r.text
    cid = r.json()["client_id"]
    a = client.get(
        "/oauth/authorize",
        params={
            "response_type": "code", "client_id": cid,
            "redirect_uri": "http://127.0.0.1:5000/cb", "code_challenge": CHALLENGE,
            "code_challenge_method": "S256", "resource": RESOURCE, "scope": "mcp",
        },
    )  # fmt: skip
    assert a.status_code == 302, a.text
    rid = parse_qs(urlsplit(a.headers["location"]).query)["request"][0]
    ok = client.post(f"/oauth/authorize/{rid}/approve", headers=ALICE)
    code = parse_qs(urlsplit(ok.json()["redirect_to"]).query)["code"][0]
    _err(_exchange(client, cid, code, redirect_uri="http://127.0.0.1:5001/cb"), "invalid_grant")
