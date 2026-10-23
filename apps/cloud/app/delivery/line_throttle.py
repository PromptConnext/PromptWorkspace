"""At most one LINE discussion notice per node per window (plan 0032).

A comment burst on one task would otherwise flood the group. In memory: a
restart forgetting the window costs at most one extra message."""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

WINDOW = timedelta(minutes=10)


class DiscussionThrottle:
    def __init__(self, window: timedelta = WINDOW) -> None:
        self._window = window
        self._last: dict[tuple[str, str], datetime] = {}
        self._lock = threading.Lock()

    def allow(self, project_id: str, node_id: str, now: datetime) -> bool:
        key = (project_id, node_id)
        with self._lock:
            last = self._last.get(key)
            if last is not None and now - last < self._window:
                return False
            self._last[key] = now
            return True
