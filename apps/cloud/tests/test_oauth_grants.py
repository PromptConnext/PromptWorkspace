"""`/me/oauth-grants` (Connected agents) and the OAuth sweep loop."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from types import SimpleNamespace

import pytest

from app.db.repository import InMemoryRepository
from app.main import _oauth_sweep_loop
from app.models.schemas import (
    OAuthClient,
    OAuthCode,
    OAuthFamily,
    OAuthRefreshToken,
    OAuthRequest,
    new_id,
    utcnow,
)
from app.oauth import supabase_users
from app.oauth.tokens import hash_token, sweep_oauth

from . import test_oauth_token as tok
from .test_oauth_token import ALICE, _code, _exchange, _family_id, _refresh, _register

BOB = {"X-User-Id": "bob"}


@pytest.fixture
def clock():
    return tok.Clock()


@pytest.fixture
def client(monkeypatch, clock):
    yield from tok.make_client(monkeypatch, clock)


@pytest.fixture(autouse=True)
def active(monkeypatch):
    async def fake(settings, user_id, *, http, cache, now=None):
        return supabase_users.UserRecord(active=True, email="")

    monkeypatch.setattr(supabase_users, "lookup_user", fake)


def _grant(client, cid, user=ALICE) -> tuple[str, str]:
    code = _code(client, cid, user)
    r = _exchange(client, cid, code)
    assert r.status_code == 200, r.text
    return _family_id(client, code), r.json()["refresh_token"]


def test_list_grants_newest_first_with_client_attribution(client, clock):
    cid = _register(client)
    claude = "claude-pre"
    client.app.state.repository.upsert_oauth_client(
        OAuthClient(
            client_id=claude,
            kind="preregistered",
            client_name="Claude",
            redirect_uris=["https://app.example/cb"],
            created_at=utcnow(),
        )
    )
    f1, _ = _grant(client, cid)
    f2, rt2 = _grant(client, cid)
    _grant(client, cid, BOB)
    client.app.state.repository.revoke_oauth_family(f1, "user_revoke", utcnow())

    r = client.get("/me/oauth-grants", headers=ALICE)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [g["family_id"] for g in rows] == [f2, f1]
    g = rows[0]
    assert set(g) == {
        "family_id", "client_id", "client_name", "vendor", "verified",
        "created_at", "last_used_at", "revoked_at",
    }  # fmt: skip
    assert g["client_id"] == cid and g["client_name"] == "App"
    assert g["vendor"] is None and g["verified"] is False
    assert g["last_used_at"] is not None and g["revoked_at"] is None
    assert rows[1]["revoked_at"] is not None


def test_grant_for_a_purged_client_still_lists(client):
    cid = _register(client)
    fid, _ = _grant(client, cid)
    client.app.state.repository._oauth_clients.pop(cid)
    rows = client.get("/me/oauth-grants", headers=ALICE).json()
    assert rows[0]["family_id"] == fid
    assert rows[0]["client_name"] == "" and rows[0]["verified"] is False


def test_delete_one_grant(client):
    cid = _register(client)
    fid, rt = _grant(client, cid)
    other, _ = _grant(client, cid)
    r = client.delete(f"/me/oauth-grants/{fid}", headers=ALICE)
    assert r.status_code == 204
    repo = client.app.state.repository
    assert repo.get_oauth_family(fid).revoked_reason == "user_revoke"
    assert repo.get_oauth_family(other).revoked_at is None
    assert _refresh(client, cid, rt).json()["error"] == "invalid_grant"


def test_delete_another_users_grant_is_404(client):
    cid = _register(client)
    bobs, _ = _grant(client, cid, BOB)
    assert client.delete(f"/me/oauth-grants/{bobs}", headers=ALICE).status_code == 404
    assert client.delete(f"/me/oauth-grants/{new_id()}", headers=ALICE).status_code == 404
    assert client.app.state.repository.get_oauth_family(bobs).revoked_at is None


def test_delete_all_grants(client):
    cid = _register(client)
    a, _ = _grant(client, cid)
    b, _ = _grant(client, cid)
    bobs, _ = _grant(client, cid, BOB)
    assert client.delete("/me/oauth-grants", headers=ALICE).status_code == 204
    repo = client.app.state.repository
    assert repo.get_oauth_family(a).revoked_reason == "user_revoke_all"
    assert repo.get_oauth_family(b).revoked_reason == "user_revoke_all"
    assert repo.get_oauth_family(bobs).revoked_at is None
    assert client.delete("/me/oauth-grants", headers=ALICE).status_code == 204


# --------------------------------------------------------------------------- #
# Sweep
# --------------------------------------------------------------------------- #


def _seed(repo: InMemoryRepository, now):
    past, future = now - timedelta(seconds=1), now + timedelta(hours=1)
    ids = {}
    for label, exp in (("old", past), ("new", future)):
        req = OAuthRequest(
            client_id="c", redirect_uri="https://a/cb", code_challenge="x", resource="r",
            scope="mcp", state=None, created_at=now, expires_at=exp,
        )  # fmt: skip
        repo.put_oauth_request(req)
        repo.put_oauth_code(
            OAuthCode(
                code_hash=f"code-{label}", request_id=req.request_id, family_id="f",
                client_id="c", user_id="u", redirect_uri="https://a/cb", code_challenge="x",
                resource="r", scope="mcp", expires_at=exp,
            )
        )  # fmt: skip
        repo.put_refresh_token(
            OAuthRefreshToken(
                token_hash=f"rt-{label}", family_id="f", client_id="c", user_id="u",
                scope="mcp", resource="r", issued_at=now, expires_at=exp,
            )
        )  # fmt: skip
        ids[label] = req.request_id
    stale = now - timedelta(days=91)
    for cid, kind, created in (
        ("dcr-stale", "dcr", stale),
        ("dcr-fresh", "dcr", now),
        ("pre-stale", "preregistered", stale),
    ):
        repo.upsert_oauth_client(
            OAuthClient(
                client_id=cid, kind=kind, redirect_uris=["https://a/cb"], created_at=created
            )
        )
    repo.put_oauth_family(OAuthFamily(family_id="f", client_id="c", user_id="u"))
    return ids


def _assert_swept(repo, ids):
    assert repo.get_oauth_request(ids["old"]) is None
    assert repo.get_oauth_request(ids["new"]) is not None
    assert repo.get_oauth_code("code-old") is None
    assert repo.get_oauth_code("code-new") is not None
    assert repo.get_refresh_token("rt-old") is None
    assert repo.get_refresh_token("rt-new") is not None
    assert repo.get_oauth_client("dcr-stale") is None
    assert repo.get_oauth_client("dcr-fresh") is not None
    assert repo.get_oauth_client("pre-stale") is not None
    assert repo.get_oauth_family("f") is not None


def test_sweep_deletes_expired_rows():
    repo = InMemoryRepository()
    now = utcnow()
    ids = _seed(repo, now)
    counts = sweep_oauth(repo, now)
    assert counts == {"requests": 1, "codes": 1, "refresh_tokens": 1, "clients": 1}
    _assert_swept(repo, ids)


def test_sweep_loop_runs_and_cancels(monkeypatch):
    repo = InMemoryRepository()
    ids = _seed(repo, utcnow())
    app = SimpleNamespace(state=SimpleNamespace(repository=repo))
    settings = SimpleNamespace(oauth_sweep_interval_seconds=5)
    sleeps = []
    real_sleep = asyncio.sleep

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) > 1:
            raise asyncio.CancelledError
        await real_sleep(0)

    monkeypatch.setattr("app.main.asyncio.sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(_oauth_sweep_loop(app, settings))
    assert sleeps == [5, 5]
    _assert_swept(repo, ids)


def test_sweep_loop_disabled_when_interval_not_positive():
    app = SimpleNamespace(state=SimpleNamespace(repository=None))
    asyncio.run(_oauth_sweep_loop(app, SimpleNamespace(oauth_sweep_interval_seconds=0)))


def test_hash_is_what_the_sweep_sees(client):
    # Sanity: refresh rows are keyed by sha256 of the raw token, never the raw.
    cid = _register(client)
    _, rt = _grant(client, cid)
    repo = client.app.state.repository
    assert repo.get_refresh_token(rt) is None
    assert repo.get_refresh_token(hash_token(rt)) is not None
