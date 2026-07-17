"""In-process, single-use, short-TTL store for desktop browser-auth handoff.

The browser deposits a Supabase session here (keyed by an opaque code) and the
desktop redeems it exactly once. Single-instance only — same posture as
presence/rate-limit (ADR 0011). Not persisted; a restart drops pending codes,
which is fine (the user just re-initiates login).
"""

from __future__ import annotations

import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class HandoffSession:
    refresh_token: str
    access_token: str
    user_id: str


class HandoffStore:
    def __init__(self, ttl_seconds: int = 120, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._items: dict[str, tuple[float, HandoffSession]] = {}

    def put(self, refresh_token: str, access_token: str, user_id: str) -> str:
        code = secrets.token_urlsafe(32)
        expires_at = self._clock() + self._ttl
        self._items[code] = (expires_at, HandoffSession(refresh_token, access_token, user_id))
        return code

    def take(self, code: str) -> HandoffSession | None:
        entry = self._items.pop(code, None)  # single-use: remove on read
        if entry is None:
            return None
        expires_at, session = entry
        if self._clock() > expires_at:
            return None
        return session
