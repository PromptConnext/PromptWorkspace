"""Compare the migrations this image ships to the ones the database has applied.

`/health` used to report the newest migration *file* in the image, which says
nothing about the database (plan 0034). This module reads the applied ledger
through `Repository.applied_migrations()` and decides whether the database is
behind the code. It blocks only on positive evidence: any failure to read the
ledger is `unknown`, never `behind`.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Literal

CACHE_TTL_SECONDS = 15.0
_CACHE_ATTR = "schema_status_cache"


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
    # Imported here: app.main imports the health router, which imports this module.
    from app.main import _MIGRATIONS_DIR

    try:
        return sorted(f"{p.stem}.sql" for p in _MIGRATIONS_DIR.glob("*.sql"))
    except OSError:
        return []


def read_status(app) -> SchemaStatus:
    """Status for `app`, cached on `app.state` for 15 s (failures are cached too)."""
    cached = getattr(app.state, _CACHE_ATTR, None)
    now = _now()
    if cached is not None and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]
    try:
        applied = app.state.repository.applied_migrations()
    except Exception:  # noqa: BLE001 - the adapter already warned; unreadable means unknown
        applied = None
    status = evaluate(_code_files(), applied)
    setattr(app.state, _CACHE_ATTR, (now, status))
    return status
