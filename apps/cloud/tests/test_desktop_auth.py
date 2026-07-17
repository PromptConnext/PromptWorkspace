# apps/cloud/tests/test_desktop_auth.py
from __future__ import annotations

from app.desktop_auth_store import HandoffStore


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
