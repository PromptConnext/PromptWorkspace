"""/health always answers 200; /ready refuses traffic while the database is behind."""


from app import ratelimit, schema_gate
from app.main import _MIGRATIONS_DIR


def _newest():
    return sorted(p.name for p in _MIGRATIONS_DIR.glob("*.sql"))[-1]


def _fresh(client):
    client.app.state.__dict__.pop("schema_status_cache", None)


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
