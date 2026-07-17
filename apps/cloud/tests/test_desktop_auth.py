# apps/cloud/tests/test_desktop_auth.py
from __future__ import annotations

from fastapi.testclient import TestClient

from app.desktop_auth_store import HandoffStore
from app.main import create_app


def test_put_then_take_returns_session():
    store = HandoffStore()
    code = store.put(refresh_token="r1", access_token="a1", user_id="alice")
    assert isinstance(code, str) and len(code) > 20
    sess = store.take(code)
    assert sess is not None
    assert (sess.refresh_token, sess.access_token, sess.user_id) == ("r1", "a1", "alice")


def test_take_is_single_use():
    store = HandoffStore()
    code = store.put("r1", "a1", "alice")
    assert store.take(code) is not None
    assert store.take(code) is None  # second time gone


def test_take_unknown_code_is_none():
    assert HandoffStore().take("nope") is None


def test_take_after_ttl_is_none():
    ticks = [1000.0]
    store = HandoffStore(ttl_seconds=120, clock=lambda: ticks[0])
    code = store.put("r1", "a1", "alice")
    ticks[0] = 1000.0 + 121  # past TTL
    assert store.take(code) is None


def _client() -> TestClient:
    app = create_app()
    return TestClient(app)


def test_handoff_then_redeem_roundtrip():
    with _client() as c:
        h = c.post(
            "/desktop-auth/handoff",
            json={"refresh_token": "r1", "access_token": "a1"},
            headers={"X-User-Id": "alice"},
        )
        assert h.status_code == 200, h.text
        code = h.json()["code"]

        r = c.post("/desktop-auth/redeem", json={"code": code})
        assert r.status_code == 200, r.text
        assert r.json() == {"access_token": "a1", "refresh_token": "r1", "user_id": "alice"}


def test_redeem_is_single_use():
    with _client() as c:
        code = c.post(
            "/desktop-auth/handoff",
            json={"refresh_token": "r1", "access_token": "a1"},
            headers={"X-User-Id": "alice"},
        ).json()["code"]
        assert c.post("/desktop-auth/redeem", json={"code": code}).status_code == 200
        assert c.post("/desktop-auth/redeem", json={"code": code}).status_code == 404


def test_redeem_unknown_code_404():
    with _client() as c:
        assert c.post("/desktop-auth/redeem", json={"code": "nope"}).status_code == 404


def test_handoff_requires_auth_in_supabase_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "x")
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        with _client() as c:
            resp = c.post(
                "/desktop-auth/handoff",
                json={"refresh_token": "r1", "access_token": "a1"},
            )  # no bearer
            assert resp.status_code == 401
    finally:
        get_settings.cache_clear()
