"""The OAuth authorization-server tables (migration 0014) on either adapter.
Single use of a code and the family revoke rules are what the token endpoint
leans on, so they must hold in Postgres, not only in the in-memory double."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.models.schemas import (
    OAuthClient,
    OAuthCode,
    OAuthFamily,
    OAuthRefreshToken,
    OAuthRequest,
    new_id,
    utcnow,
)

pytestmark = pytest.mark.contract


def _client(kind="dcr", **kw) -> OAuthClient:
    kw.setdefault("created_at", utcnow())
    return OAuthClient(
        client_id=f"c-{new_id()}", kind=kind, redirect_uris=["http://127.0.0.1/cb"], **kw
    )


def _request(minutes: int = 10) -> OAuthRequest:
    now = utcnow()
    return OAuthRequest(
        client_id="c1",
        redirect_uri="http://127.0.0.1/cb",
        code_challenge="ch",
        resource="https://mcp.example/mcp",
        scope="mcp",
        state="s",
        created_at=now,
        expires_at=now + timedelta(minutes=minutes),
    )


def _code(h: str) -> OAuthCode:
    return OAuthCode(
        code_hash=h,
        request_id=new_id(),
        family_id=new_id(),
        client_id="c1",
        user_id=new_id(),
        redirect_uri="http://127.0.0.1/cb",
        code_challenge="ch",
        resource="r",
        scope="mcp",
        expires_at=utcnow() + timedelta(minutes=1),
    )


def _token(h: str, family_id: str, user_id: str, days: int = 30) -> OAuthRefreshToken:
    now = utcnow()
    return OAuthRefreshToken(
        token_hash=h,
        family_id=family_id,
        client_id="c1",
        user_id=user_id,
        scope="mcp",
        resource="r",
        issued_at=now,
        expires_at=now + timedelta(days=days),
    )


def _family(user_id: str, **kw) -> OAuthFamily:
    return OAuthFamily(family_id=new_id(), client_id="c1", user_id=user_id, **kw)


def test_client_round_trip_and_dcr_purge(repo: Repository) -> None:
    old = _client(created_at=utcnow() - timedelta(days=40))
    old.metadata = {"a": 1}
    fresh = _client()
    used = _client(created_at=utcnow() - timedelta(days=40), last_used_at=utcnow())
    pre = _client("preregistered", created_at=utcnow() - timedelta(days=400))
    for c in (old, fresh, used, pre):
        repo.upsert_oauth_client(c)
    assert repo.get_oauth_client(old.client_id).metadata == {"a": 1}
    assert repo.get_oauth_client("nope-" + new_id()) is None
    assert repo.delete_oauth_clients_unused_since(utcnow() - timedelta(days=30)) >= 1
    assert repo.get_oauth_client(old.client_id) is None
    for keep in (fresh, used, pre):
        assert repo.get_oauth_client(keep.client_id) is not None


def test_request_put_get_update_and_expiry(repo: Repository) -> None:
    r = _request()
    repo.put_oauth_request(r)
    r.approved_user_id, r.approved_at = new_id(), utcnow()
    repo.update_oauth_request(r)
    got = repo.get_oauth_request(r.request_id)
    assert got.approved_user_id == r.approved_user_id and got.state == "s"
    assert repo.delete_oauth_requests_expired(utcnow() + timedelta(minutes=11)) >= 1
    assert repo.get_oauth_request(r.request_id) is None


def test_code_is_taken_once_then_visible_as_used(repo: Repository) -> None:
    h = "code-" + new_id()
    repo.put_oauth_code(_code(h))
    assert repo.get_oauth_code(h).used_at is None
    first = repo.take_oauth_code(h, utcnow())
    assert first is not None
    assert repo.take_oauth_code(h, utcnow()) is None
    assert repo.get_oauth_code(h).used_at is not None
    assert repo.take_oauth_code("missing-" + new_id(), utcnow()) is None


def test_refresh_rotation_fields_persist_and_expiry_purge(repo: Repository) -> None:
    fam = _family(new_id())
    repo.put_oauth_family(fam)
    t = _token("rt-" + new_id(), fam.family_id, fam.user_id)
    repo.put_refresh_token(t)
    t.rotated_to_hash, t.rotated_at, t.last_used_at, t.user_agent = "next", utcnow(), utcnow(), "ua"
    repo.update_refresh_token(t)
    got = repo.get_refresh_token(t.token_hash)
    assert (got.rotated_to_hash, got.user_agent) == ("next", "ua")
    assert got.rotated_at is not None and got.revoked_at is None
    assert repo.delete_refresh_tokens_expired(utcnow() + timedelta(days=31)) >= 1
    assert repo.get_refresh_token(t.token_hash) is None


def test_family_revoke_list_and_bulk_revoke(repo: Repository) -> None:
    user = new_id()
    a = _family(user, created_at=utcnow() - timedelta(hours=2))
    b = _family(user, created_at=utcnow() - timedelta(hours=1))
    c = _family(user, created_at=utcnow())
    for f in (a, b, c):
        repo.put_oauth_family(f)
    assert [f.family_id for f in repo.list_oauth_families_for_user(user)] == [
        c.family_id,
        b.family_id,
        a.family_id,
    ]
    revoked = repo.revoke_oauth_family(a.family_id, "reuse", utcnow())
    assert revoked.revoked_reason == "reuse" and revoked.revoked_at is not None
    again = repo.revoke_oauth_family(a.family_id, "other", utcnow())
    assert again.revoked_reason == "reuse"
    assert repo.revoke_oauth_family(new_id(), "x", utcnow()) is None
    assert repo.revoke_oauth_families_for_user(user, "user", utcnow()) == 2
    assert repo.revoke_oauth_families_for_user(user, "user", utcnow()) == 0
    assert repo.get_oauth_family(b.family_id).revoked_reason == "user"


def test_expired_codes_purge(repo: Repository) -> None:
    old, live = _code("code-" + new_id()), _code("code-" + new_id())
    old.expires_at = utcnow() - timedelta(minutes=1)
    repo.put_oauth_code(old)
    repo.put_oauth_code(live)
    assert repo.delete_oauth_codes_expired(utcnow()) >= 1
    assert repo.get_oauth_code(old.code_hash) is None
    assert repo.get_oauth_code(live.code_hash) is not None


def test_family_touch_sets_last_used(repo: Repository) -> None:
    fam = _family(new_id())
    repo.put_oauth_family(fam)
    assert repo.get_oauth_family(fam.family_id).last_used_at is None
    at = utcnow()
    repo.touch_oauth_family(fam.family_id, at)
    got = repo.get_oauth_family(fam.family_id).last_used_at
    assert got is not None and abs((got - at).total_seconds()) < 1
    repo.touch_oauth_family(new_id(), at)  # unknown family: a no-op


def test_refresh_rotation_claim_is_single_winner(repo: Repository) -> None:
    fam = _family(new_id())
    repo.put_oauth_family(fam)
    t = _token("rt-" + new_id(), fam.family_id, fam.user_id)
    repo.put_refresh_token(t)
    now = utcnow()
    assert repo.claim_refresh_rotation(t.token_hash, "succ-a", now) is True
    assert repo.claim_refresh_rotation(t.token_hash, "succ-b", now) is False
    got = repo.get_refresh_token(t.token_hash)
    assert got.rotated_to_hash == "succ-a"
    assert got.rotated_at is not None and got.last_used_at is not None
    assert repo.claim_refresh_rotation("missing-" + new_id(), "x", now) is False


def test_client_touch_sets_only_last_used(repo: Repository) -> None:
    c = _client(client_name="Name")
    repo.upsert_oauth_client(c)
    at = utcnow()
    repo.touch_oauth_client(c.client_id, at)
    got = repo.get_oauth_client(c.client_id)
    assert got.client_name == "Name" and got.redirect_uris == c.redirect_uris
    assert got.last_used_at is not None and abs((got.last_used_at - at).total_seconds()) < 1
    repo.touch_oauth_client("nope-" + new_id(), at)  # unknown client: a no-op
