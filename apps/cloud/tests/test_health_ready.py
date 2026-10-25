"""/health always answers 200; /ready refuses traffic while the database is behind."""


import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import ratelimit, schema_gate
from app.schema_gate import MIGRATIONS_DIR as _MIGRATIONS_DIR


@pytest.fixture(autouse=True)
def _reset_inflight():
    schema_gate._inflight = None
    yield
    schema_gate._inflight = None


def _settle():
    attempt = schema_gate._inflight
    if attempt is not None:
        attempt.done.wait(1)


def _newest():
    return sorted(p.name for p in _MIGRATIONS_DIR.glob("*.sql"))[-1]


def _fresh(client):
    client.app.state.__dict__.pop(schema_gate._CACHE_ATTR, None)


def _behind(client, monkeypatch):
    applied = sorted(p.name for p in _MIGRATIONS_DIR.glob("*.sql"))[:-1]
    monkeypatch.setattr(client.app.state.repository, "applied_migrations", lambda: applied)
    _fresh(client)


def test_ready_on_memory_backend_is_ok_with_unknown_state(client):
    res = client.get("/ready")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["schema"] == {"state": "unknown", "pending": [], "applied_latest": None}


def test_health_reports_schema_and_keeps_schema_version(client):
    body = client.get("/health").json()
    assert body["schema"]["state"] == "unknown"
    assert "schema_version" in body


def test_ready_is_503_when_behind_and_health_stays_200(client, monkeypatch):
    _behind(client, monkeypatch)
    ready = client.get("/ready")
    assert ready.status_code == 503
    body = ready.json()
    assert body["status"] == "schema_behind"
    assert body["schema"]["state"] == "behind"
    assert body["schema"]["pending"] == [_newest()]
    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["schema"]["pending"] == [_newest()]


def test_ready_is_200_when_ledger_is_complete(client, monkeypatch):
    applied = sorted(p.name for p in _MIGRATIONS_DIR.glob("*.sql"))
    monkeypatch.setattr(client.app.state.repository, "applied_migrations", lambda: applied)
    _fresh(client)
    res = client.get("/ready")
    assert res.status_code == 200
    assert res.json()["schema"]["state"] == "ok"


def test_ledger_read_is_cached_across_requests(client, monkeypatch):
    calls = []

    def fake():
        calls.append(1)
        return []

    monkeypatch.setattr(client.app.state.repository, "applied_migrations", fake)
    monkeypatch.setattr(schema_gate, "_now", lambda: 5.0)
    _fresh(client)
    client.get("/ready")
    client.get("/health")
    assert len(calls) == 1


def test_raising_ledger_read_is_unknown_and_ready(client, monkeypatch):
    def boom():
        raise RuntimeError("down")

    monkeypatch.setattr(client.app.state.repository, "applied_migrations", boom)
    _fresh(client)
    res = client.get("/ready")
    assert res.status_code == 200
    assert res.json()["schema"]["state"] == "unknown"


def test_ready_gets_the_same_rate_limit_treatment_as_health():
    # Neither probe path is in the limiter's prefixes: the liveness/readiness
    # probes must never be throttled, and nothing else special-cases /health.
    for path in ("/health", "/ready"):
        assert not path.startswith(ratelimit._LIMITED_PREFIXES)
        assert not path.endswith(ratelimit._LIMITED_SUFFIXES)


def test_a_hung_ledger_read_is_bounded(client, monkeypatch):
    release = threading.Event()

    def hang():
        release.wait(10)
        return []

    monkeypatch.setattr(client.app.state.repository, "applied_migrations", hang)
    monkeypatch.setattr(schema_gate, "_PROBE_TIMEOUT", 0.2)
    _fresh(client)
    try:
        start = time.monotonic()
        res = client.get("/ready")
        elapsed = time.monotonic() - start
        assert res.status_code == 200
        assert res.json()["schema"]["state"] == "unknown"
        assert elapsed < 1.0
    finally:
        release.set()
        _settle()


def test_probes_during_a_hang_do_not_pile_up(client, monkeypatch):
    release = threading.Event()
    calls = []

    def hang():
        calls.append(1)
        release.wait(10)
        return []

    clock = {"now": 100.0}
    monkeypatch.setattr(client.app.state.repository, "applied_migrations", hang)
    monkeypatch.setattr(schema_gate, "_PROBE_TIMEOUT", 0.2)
    monkeypatch.setattr(schema_gate, "_now", lambda: clock["now"])
    _fresh(client)
    try:
        assert schema_gate.read_status(client.app).state == "unknown"
        clock["now"] += 60  # TTL expired, worker still stuck
        for _ in range(20):
            assert schema_gate.read_status(client.app).state == "unknown"
        assert len(calls) == 1
    finally:
        release.set()
        _settle()


def test_ready_recovers_after_ttl_when_database_catches_up(client, monkeypatch):
    names = sorted(p.name for p in _MIGRATIONS_DIR.glob("*.sql"))
    answer = {"v": names[:-1]}
    clock = {"now": 100.0}
    monkeypatch.setattr(client.app.state.repository, "applied_migrations", lambda: answer["v"])
    monkeypatch.setattr(schema_gate, "_now", lambda: clock["now"])
    _fresh(client)
    assert client.get("/ready").status_code == 503
    answer["v"] = names
    assert client.get("/ready").status_code == 503  # still cached
    clock["now"] += schema_gate.CACHE_TTL_SECONDS + 1
    assert client.get("/ready").status_code == 200


def test_health_keeps_every_pre_existing_key(client):
    keys = {"status", "service", "version", "backend", "schema_version", "env",
            "metrics", "capacity", "time"}
    assert keys | {"schema"} <= set(client.get("/health").json())


def test_a_wedged_probe_does_not_block_interpreter_exit():
    import subprocess
    import sys

    code = (
        "import threading\n"
        "from types import SimpleNamespace\n"
        "from app import schema_gate\n"
        "schema_gate._PROBE_TIMEOUT = 0.2\n"
        "class R:\n"
        "    def applied_migrations(self):\n"
        "        threading.Event().wait()\n"
        "app = SimpleNamespace(state=SimpleNamespace(repository=R()))\n"
        "assert schema_gate.read_status(app).state == 'unknown'\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], timeout=10, capture_output=True,
        cwd=Path(__file__).resolve().parents[1],
    )
    assert done.returncode == 0, done.stderr


def _bare_app(repo):
    return SimpleNamespace(state=SimpleNamespace(repository=repo))


def test_probe_right_after_a_released_hang_always_reaches_the_ledger(monkeypatch):
    monkeypatch.setattr(schema_gate, "_PROBE_TIMEOUT", 0.01)
    for _ in range(50):
        release = threading.Event()
        hung = SimpleNamespace(applied_migrations=lambda ev=release: ev.wait(10) and [])
        schema_gate._inflight = None
        assert schema_gate.read_status(_bare_app(hung)).state == "unknown"
        release.set()
        _settle()
        calls = []
        fresh = SimpleNamespace(applied_migrations=lambda c=calls: c.append(1) or [])
        schema_gate.read_status(_bare_app(fresh))
        assert calls == [1]


def test_thread_start_failure_is_unknown_not_a_500(monkeypatch):
    def boom(self):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", boom)
    app = _bare_app(SimpleNamespace(applied_migrations=lambda: []))
    assert schema_gate.read_status(app).state == "unknown"
    assert schema_gate._inflight is None


def test_cache_is_rechecked_inside_the_lock(monkeypatch):
    calls = []
    app = _bare_app(SimpleNamespace(applied_migrations=lambda: calls.append(1) or []))
    filled = schema_gate.evaluate(["x.sql"], ["x.sql"])

    class FillOnEnter:
        """Another probe finishes between our unlocked TTL check and the lock."""

        def __enter__(self):
            setattr(app.state, schema_gate._CACHE_ATTR, (schema_gate._now(), filled))

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(schema_gate, "_lock", FillOnEnter())
    assert schema_gate.read_status(app) is filled
    assert calls == []
