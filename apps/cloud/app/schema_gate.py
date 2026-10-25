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
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"

CACHE_TTL_SECONDS = 15.0
_CACHE_ATTR = "schema_status_cache"
_PROBE_TIMEOUT = 3.0  # seconds a probe waits for the ledger RPC


def _now() -> float:
    """Injectable clock for tests."""
    return time.monotonic()


class _Attempt:
    """One ledger call on a daemon thread; `done` is set when it returns or raises."""

    def __init__(self, fn) -> None:
        self.done = threading.Event()
        self.applied: list[str] | None = None
        threading.Thread(target=self._run, args=(fn,), daemon=True, name="schema-gate").start()

    def _run(self, fn) -> None:
        try:
            self.applied = fn()
        except Exception:  # noqa: BLE001 - the adapter already warned; unreadable is unknown
            self.applied = None
        finally:
            self.done.set()


# Single-flight: at most one ledger call is ever in progress. A daemon thread
# (not an executor) so a wedged call cannot delay interpreter exit on shutdown.
_lock = threading.Lock()
_inflight: _Attempt | None = None


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
        # Re-check: another probe may have finished since the unlocked check above.
        cached = getattr(app.state, _CACHE_ATTR, None)
        if cached is not None and _now() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
        if _inflight is not None and not _inflight.done.is_set():
            return cached[1] if cached is not None else evaluate(_code_files(), None)
        try:
            attempt = _Attempt(app.state.repository.applied_migrations)
        except RuntimeError:  # cannot start a thread: unknown, never a 500
            attempt = None
        else:
            _inflight = attempt
    # A timed-out attempt is abandoned: its late result lands on `attempt` only.
    applied = attempt.applied if attempt and attempt.done.wait(_PROBE_TIMEOUT) else None
    status = evaluate(_code_files(), applied)
    setattr(app.state, _CACHE_ATTR, (_now(), status))
    return status
