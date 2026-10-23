"""At most one LINE discussion notice per node per window (plan 0032).

A comment burst on one task would otherwise flood the group. Comments the
window holds back are not dropped: the next comment let through on that node
reports them with it, so its notice covers everything since the last send. A
burst nobody follows up is never sent. In memory: a restart forgetting the
window costs at most one extra message."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta

WINDOW = timedelta(minutes=10)


@dataclass(frozen=True)
class Burst:
    """What one notice reports: comments since the last send, this one included,
    and their distinct authors in the order they first commented."""

    count: int
    authors: tuple[str, ...]


@dataclass
class _Node:
    last_sent: datetime
    held: int = 0
    authors: list[str] = field(default_factory=list)


class DiscussionThrottle:
    def __init__(self, window: timedelta = WINDOW) -> None:
        self._window = window
        self._nodes: dict[tuple[str, str], _Node] = {}
        self._lock = threading.Lock()

    def allow(self, project_id: str, node_id: str, author: str, now: datetime) -> Burst | None:
        """The burst to report now, or None when this comment is held back."""
        key = (project_id, node_id)
        with self._lock:
            node = self._nodes.get(key)
            if node is None:
                self._nodes[key] = _Node(last_sent=now)
                return Burst(1, (author,))
            authors = node.authors if author in node.authors else [*node.authors, author]
            if now - node.last_sent < self._window:
                node.held += 1
                node.authors = authors
                return None
            burst = Burst(node.held + 1, tuple(authors))
            self._nodes[key] = _Node(last_sent=now)
            return burst
