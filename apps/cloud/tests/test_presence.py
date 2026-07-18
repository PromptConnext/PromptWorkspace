"""Tests for real-time presence over WebSocket (M6)."""

from __future__ import annotations

import pytest
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


def test_heartbeat_updates_cursor_hint(client):
    pid = _project_with_two_members(client)
    with client.websocket_connect(f"/ws/projects/{pid}/presence?user_id=alice") as a:
        a.receive_json()  # initial roster
        a.send_json({"cursor_hint": "task:t1"})
        roster = a.receive_json()
        me = next(u for u in roster["users"] if u["user_id"] == "alice")
        assert me["cursor_hint"] == "task:t1"


# --------------------------------------------------------------------------- #
# Idle prune (unit — deterministic, no timers)
# --------------------------------------------------------------------------- #
class _FakeSocket:
    async def accept(self):
        pass

    async def send_json(self, message):
        pass


@pytest.mark.anyio
async def test_prune_removes_idle_connections():
    mgr = ConnectionManager(max_per_project=10)
    s1, s2 = _FakeSocket(), _FakeSocket()
    await mgr.connect("p1", s1, "alice", now=0.0)
    await mgr.connect("p1", s2, "bob", now=100.0)
    # At t=110 with ttl=20: alice (last_seen 0) is idle, bob (100) is not.
    stale = mgr.prune_idle("p1", ttl=20.0, now=110.0)
    assert stale == [s1]
    assert {u["user_id"] for u in mgr.roster("p1")} == {"bob"}


def test_capacity_limit_rejects_extra_connections():
    import asyncio

    async def run():
        mgr = ConnectionManager(max_per_project=1)
        s1, s2 = _FakeSocket(), _FakeSocket()
        assert await mgr.connect("p1", s1, "alice", now=0.0) is True
        # Second connection to a full room is refused (not accepted).
        assert await mgr.connect("p1", s2, "bob", now=0.0) is False

    asyncio.run(run())


@pytest.fixture
def anyio_backend():
    return "asyncio"
