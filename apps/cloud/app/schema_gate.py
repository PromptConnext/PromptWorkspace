"""Compare the migrations this image ships to the ones the database has applied.

`/health` used to report the newest migration *file* in the image, which says
nothing about the database (plan 0034). This module reads the applied ledger
through `Repository.applied_migrations()` and decides whether the database is
behind the code. It blocks only on positive evidence: any failure to read the
ledger is `unknown`, never `behind`.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

CACHE_TTL_SECONDS = 15.0
_CACHE_ATTR = "schema_status_cache"
_PROBE_TIMEOUT = 3.0  # seconds a probe waits for the ledger RPC

# One worker, one call in flight: a hung RPC wedges at most this one thread.
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="schema-gate")
_lock = threading.Lock()
_inflight: Future | None = None


def _now() -> float:
    """Injectable clock for tests."""
    return time.monotonic()


@dataclass(frozen=True)
class SchemaStatus:
    state: Literal["ok", "behind", "unknown"]
    pending: list[str]
    applied_latest: str | None
    code_latest: str


def evaluate(code_files: list[str], applied: list[str] | None) -> SchemaStatus:
    """Pure comparison by filename set difference, never by position."""
    code_latest = max(code_files) if code_files else "none"
    if applied is None:
        return SchemaStatus("unknown", [], None, code_latest)
    applied_latest = max(applied) if applied else None
    pending = sorted(set(code_files) - set(applied))
    return SchemaStatus("behind" if pending else "ok", pending, applied_latest, code_latest)


def _code_files() -> list[str]:
    try:
        return sorted(f"{p.stem}.sql" for p in MIGRATIONS_DIR.glob("*.sql"))
    except OSError:
        return []


def read_status(app) -> SchemaStatus:
    """Status for `app`, cached on `app.state` for 15 s (failures are cached too).

    The ledger call is single-flight and time-bounded: while a previous call is
    still running no new one starts, and callers get the last cached status (or
    `unknown`) immediately, so a hung database cannot pile up threads.
    """
    global _inflight
    cached = getattr(app.state, _CACHE_ATTR, None)
    if cached is not None and _now() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]
    with _lock:
        if _inflight is not None and not _inflight.done():
            return cached[1] if cached is not None else evaluate(_code_files(), None)
        _inflight = future = _executor.submit(app.state.repository.applied_migrations)
    try:
        applied = future.result(timeout=_PROBE_TIMEOUT)
    except FutureTimeout:
        applied = None
    except Exception:  # noqa: BLE001 - the adapter already warned; unreadable means unknown
        applied = None
    status = evaluate(_code_files(), applied)
    setattr(app.state, _CACHE_ATTR, (_now(), status))
    return status
