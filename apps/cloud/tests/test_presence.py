"""Tests for real-time presence over WebSocket (M6)."""

from __future__ import annotations

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.ws.manager import ConnectionManager


def _project_with_two_members(client):
    ws = client.post("/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}).json()
    pid = client.post(
        "/projects",
        json={"name": "P", "workspace_id": ws["id"]},
        headers={"X-User-Id": "alice"},
    ).json()["id"]
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations",
        json={"email": "bob@x.com"},
        headers={"X-User-Id": "alice"},
    ).json()
    client.post(
        f"/invitations/{inv['invitation']['token']}/accept", headers={"X-User-Id": "bob"}
    )
    return pid


def test_non_member_socket_rejected(client):
    pid = _project_with_two_members(client)
    # carol is not a member → the socket is closed before accept.
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/ws/projects/{pid}/presence?user_id=carol"
        ) as ws:
            ws.receive_json()


def test_unknown_project_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            "/ws/projects/does-not-exist/presence?user_id=alice"
        ) as ws:
            ws.receive_json()


def test_two_clients_see_each_others_presence(client):
    pid = _project_with_two_members(client)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        first = a.receive_json()
        assert first["type"] == "presence"
        assert {u["user_id"] for u in first["users"]} == {"alice"}

        with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob") as b:
            # Both sockets get a roster update showing alice + bob.
            roster_b = b.receive_json()
            roster_a = a.receive_json()
            assert {u["user_id"] for u in roster_b["users"]} == {"alice", "bob"}
            assert {u["user_id"] for u in roster_a["users"]} == {"alice", "bob"}

        # After bob disconnects, alice sees just herself again.
        roster_a2 = a.receive_json()
        assert {u["user_id"] for u in roster_a2["users"]} == {"alice"}


def test_client_frame_updates_state_but_is_not_rebroadcast(client):
    """A heartbeat (or cursor_hint) frame must produce no outbound frame to any
    socket in the room; the next frame each side sees is the *next* roster
    change, not an echo of the heartbeat."""
    pid = _project_with_two_members(client)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()  # alice's join
        with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob") as b:
            b.receive_json()
            a.receive_json()  # bob's join
            a.send_json({})
            b.send_json({"cursor_hint": "task:t1"})
            b.send_json({})
            # State is still updated server-side.
            hints = {u["user_id"]: u["cursor_hint"] for u in client.app.state.presence.roster(pid)}
            assert hints["bob"] == "task:t1"
        # Bob leaves. If any heartbeat had been rebroadcast, alice would see an
        # extra {alice, bob} roster before this one.
        nxt = a.receive_json()
        assert {u["user_id"] for u in nxt["users"]} == {"alice"}


def test_second_socket_of_same_user_does_not_broadcast(client):
    pid = _project_with_two_members(client)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a1:
        a1.receive_json()
        with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice"):
            # The second tab is accepted but nothing is sent to anyone.
            assert client.app.state.presence.occupancy() == (1, 2)
            with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob") as b:
                # First frame a1 sees after bob joins is bob's roster, so the
                # a2 join produced nothing.
                assert {u["user_id"] for u in a1.receive_json()["users"]} == {"alice", "bob"}
                b.receive_json()
        # Bob left (broadcast); now a2 leaves while a1 remains (no broadcast).
        assert {u["user_id"] for u in a1.receive_json()["users"]} == {"alice"}
    assert client.app.state.presence.occupancy() == (0, 0)


def test_last_socket_leave_broadcasts_to_remaining_room(client):
    pid = _project_with_two_members(client)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()
        with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob"):
            assert {u["user_id"] for u in a.receive_json()["users"]} == {"alice", "bob"}
        assert {u["user_id"] for u in a.receive_json()["users"]} == {"alice"}


def test_per_user_cap_refuses_with_1013(client):
    pid = _project_with_two_members(client)
    client.app.state.presence = ConnectionManager(10, 100, 1)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice"):
                pass
        assert exc.value.code == 1013
        assert client.app.state.presence.occupancy() == (1, 1)


def test_per_project_cap_refuses_with_1013(client):
    pid = _project_with_two_members(client)
    client.app.state.presence = ConnectionManager(1, 100, 5)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob"):
                pass
        assert exc.value.code == 1013


def test_global_cap_refuses_with_1013_and_frees_after_disconnect(client):
    pid = _project_with_two_members(client)
    client.app.state.presence = ConnectionManager(10, 1, 5)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob"):
                pass
        assert exc.value.code == 1013
    # Cap freed once alice disconnects.
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=bob") as b:
        assert b.receive_json()["type"] == "presence"


def test_es256_jwks_token_accepted(monkeypatch):
    """A JWKS-verified ES256 bearer token authenticates the presence socket,
    matching the REST auth path (`app.dependencies._verify_jwt`). Before the
    unification, `_identify()` only accepted HS256 tokens signed with
    `SUPABASE_JWT_SECRET`; this proves the JWKS/ES256 branch is now reachable
    from presence too. `SUPABASE_JWT_SECRET` is deliberately left unset so
    the HS256 fallback can't be what authenticates the socket.
    """
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.delenv("SUPABASE_JWT_SECRET", raising=False)

    from app import dependencies
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        # Mint a real ES256 token with a fresh EC (P-256) keypair.
        private_key = ec.generate_private_key(ec.SECP256R1())
        public_key = private_key.public_key()
        token = jwt.encode(
            {"sub": "alice", "email": "alice@x.com", "aud": "authenticated"},
            private_key,
            algorithm="ES256",
            headers={"kid": "test-key"},
        )

        # Stub out the JWKS fetch so the test stays hermetic (no real network
        # call to SUPABASE_URL/auth/v1/.well-known/jwks.json) while still
        # exercising the real `_verify_jwt` JWKS-first code path.
        class _FakeSigningKey:
            key = public_key

        class _FakeJwksClient:
            def get_signing_key_from_jwt(self, _token):
                return _FakeSigningKey()

        monkeypatch.setattr(
            dependencies, "_jwks_client", lambda _url: _FakeJwksClient()
        )

        from app.main import create_app

        app = create_app()
        with TestClient(app) as c:
            auth_headers = {"Authorization": f"Bearer {token}"}
            ws = c.post("/workspaces", json={"name": "W"}, headers=auth_headers).json()
            pid = c.post(
                "/projects",
                json={"name": "P", "workspace_id": ws["id"]},
                headers=auth_headers,
            ).json()["id"]

            with c.websocket_connect(
                f"/ws/projects/{pid}/presence?token={token}"
            ) as sock:
                roster = sock.receive_json()
                assert roster["type"] == "presence"
                assert {u["user_id"] for u in roster["users"]} == {"alice"}
    finally:
        get_settings.cache_clear()


@pytest.mark.anyio
async def test_client_hangup_during_broadcast_is_not_an_asgi_error():
    """A client that drops while the roster is being fanned out.

    `broadcast_roster` sends to every socket in the room including this one;
    starlette turns the failed send into `WebSocketDisconnect` *and* marks the
    socket DISCONNECTED, and the fan-out swallows the exception so the other
    members still get their update. The handler must notice, not go on to
    `receive_json()` — which raises a bare RuntimeError that is not
    WebSocketDisconnect and surfaced as an ASGI traceback in the logs.
    """
    from starlette.websockets import WebSocketState

    from app.api.presence import presence
    from app.main import create_app

    app = create_app()
    with TestClient(app) as c:
        ws = c.post("/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}).json()
        pid = c.post(
            "/projects",
            json={"name": "P", "workspace_id": ws["id"]},
            headers={"X-User-Id": "alice"},
        ).json()["id"]

    class _HangingUpSocket:
        """Mimics starlette's own behaviour when the peer is already gone:
        the send raises WebSocketDisconnect and leaves the socket
        DISCONNECTED (starlette.websockets.WebSocket.send, OSError branch)."""

        def __init__(self, scope_app):
            self.app = scope_app
            self.query_params = {"user_id": "alice"}
            self.application_state = WebSocketState.CONNECTING
            self.receive_calls = 0

        async def accept(self):
            self.application_state = WebSocketState.CONNECTED

        async def send_json(self, message):
            self.application_state = WebSocketState.DISCONNECTED
            raise WebSocketDisconnect(code=1006)

        async def receive_json(self):
            self.receive_calls += 1
            raise RuntimeError('WebSocket is not connected. Need to call "accept" first.')

        async def close(self, code=1000):
            self.application_state = WebSocketState.DISCONNECTED

    socket = _HangingUpSocket(app)
    await presence(socket, pid)  # must not raise

    assert socket.receive_calls == 0
    # And the room is left clean for the members still connected.
    assert app.state.presence.roster(pid) == []


# --------------------------------------------------------------------------- #
# Caps (unit — deterministic)
# --------------------------------------------------------------------------- #
class _FakeSocket:
    def __init__(self):
        self.accepted = False

    async def accept(self):
        self.accepted = True

    async def send_json(self, message):
        pass


@pytest.mark.anyio
async def test_each_cap_refuses_without_accepting_and_frees_on_disconnect():
    mgr = ConnectionManager(max_per_project=2, max_total=3, max_per_user=1)
    a1, a2 = _FakeSocket(), _FakeSocket()
    assert await mgr.connect("p1", a1, "alice", now=0.0) is True
    # per-user cap
    assert await mgr.connect("p1", a2, "alice", now=0.0) is False
    assert a2.accepted is False
    b1, c1 = _FakeSocket(), _FakeSocket()
    assert await mgr.connect("p1", b1, "bob", now=0.0) is True
    # per-project cap (room has 2)
    assert await mgr.connect("p1", c1, "carol", now=0.0) is False
    assert c1.accepted is False
    # global cap (3 total)
    assert await mgr.connect("p2", _FakeSocket(), "x", now=0.0) is True
    over = _FakeSocket()
    assert await mgr.connect("p3", over, "y", now=0.0) is False
    assert over.accepted is False
    # free a slot -> accepted again
    mgr.disconnect("p1", a1)
    assert await mgr.connect("p3", over, "y", now=0.0) is True


def test_capacity_limit_rejects_extra_connections():
    import asyncio

    async def run():
        mgr = ConnectionManager(1, 10, 10)
        s1, s2 = _FakeSocket(), _FakeSocket()
        assert await mgr.connect("p1", s1, "alice", now=0.0) is True
        # Second connection to a full room is refused (not accepted).
        assert await mgr.connect("p1", s2, "bob", now=0.0) is False

    asyncio.run(run())


@pytest.fixture
def anyio_backend():
    return "asyncio"
