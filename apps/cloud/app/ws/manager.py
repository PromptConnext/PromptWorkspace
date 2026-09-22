"""In-memory WebSocket connection manager for presence (M6).

Tracks who is viewing/editing each project and fans out roster updates. No graph
data ever flows over WebSocket — presence is ephemeral and never persisted.

Single-process only. Horizontal scale needs a shared backplane (Redis pub/sub
or a managed realtime service); this is flagged, not solved, for v1. One manager
lives on `app.state.presence` so each app instance (and each test) is isolated.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Presence:
    user_id: str
    cursor_hint: str | None
    last_seen: float


class ConnectionManager:
    def __init__(self, max_per_project: int) -> None:
        self._max = max_per_project
        # project_id -> {socket: Presence}
        self._rooms: dict[str, dict[object, Presence]] = {}

    async def connect(
        self, project_id: str, socket, user_id: str, now: float
    ) -> bool:
        """Accept the socket and join the room. Returns False (without accepting)
        when the room is at capacity, so the caller can reject with a code."""
        room = self._rooms.setdefault(project_id, {})
        if len(room) >= self._max:
            return False
        await socket.accept()
        room[socket] = Presence(user_id=user_id, cursor_hint=None, last_seen=now)
        return True

    def disconnect(self, project_id: str, socket) -> None:
        room = self._rooms.get(project_id)
        if room:
            room.pop(socket, None)
            if not room:
                self._rooms.pop(project_id, None)

    def touch(self, project_id: str, socket, cursor_hint, now: float) -> None:
        presence = self._rooms.get(project_id, {}).get(socket)
        if presence is None:
            return
        presence.last_seen = now
        if cursor_hint is not None:
            presence.cursor_hint = cursor_hint

    def roster(self, project_id: str) -> list[dict]:
        """De-duplicated who's-here list (one entry per user, newest cursor)."""
        by_user: dict[str, Presence] = {}
        for presence in self._rooms.get(project_id, {}).values():
            existing = by_user.get(presence.user_id)
            if existing is None or presence.last_seen >= existing.last_seen:
                by_user[presence.user_id] = presence
        return [
            {"user_id": p.user_id, "cursor_hint": p.cursor_hint, "last_seen": p.last_seen}
            for p in by_user.values()
        ]

    async def broadcast_roster(self, project_id: str) -> None:
        message = {"type": "presence", "users": self.roster(project_id)}
        for socket in list(self._rooms.get(project_id, {})):
            try:
                await socket.send_json(message)
            except Exception:  # noqa: BLE001 - a dead socket must not break fan-out
                self.disconnect(project_id, socket)

    def occupancy(self) -> tuple[int, int]:
        """(projects with at least one live socket, total live sockets).

        Read-only, for the single-instance report on /health (plan 0021 M4,
        see app/capacity.py). `rooms` needs no "non-empty" filter: both
        `disconnect` and `prune_idle` drop a room that empties, so a key here
        always has a socket behind it.
        """
        return len(self._rooms), sum(len(room) for room in self._rooms.values())

    def prune_idle(self, project_id: str, ttl: float, now: float) -> list[object]:
        """Drop connections idle longer than `ttl`. Returns the removed sockets
        so the caller can close them. Deterministic — no timers involved."""
        room = self._rooms.get(project_id, {})
        stale = [s for s, p in room.items() if now - p.last_seen > ttl]
        for socket in stale:
            room.pop(socket, None)
        if not room:
            self._rooms.pop(project_id, None)
        return stale
