"""The pure comparison of shipped migrations to the database ledger (plan 0034)."""

from types import SimpleNamespace

import pytest

from app import schema_gate
from app.schema_gate import SchemaStatus, evaluate, read_status

CODE = ["0001_ledger.sql", "0002_schema.sql", "0003_extra.sql"]


def test_ok_when_all_code_files_are_applied():
    s = evaluate(CODE, list(CODE))
    assert s == SchemaStatus("ok", [], "0003_extra.sql", "0003_extra.sql")


def test_behind_lists_pending_sorted():
    s = evaluate(CODE, ["0001_ledger.sql"])
    assert s.state == "behind"
    assert s.pending == ["0002_schema.sql", "0003_extra.sql"]
    assert s.applied_latest == "0001_ledger.sql"
    assert s.code_latest == "0003_extra.sql"


def test_database_ahead_of_code_is_ok():
    s = evaluate(CODE, [*CODE, "0009_from_newer_image.sql"])
    assert s.state == "ok"
    assert s.pending == []
    assert s.applied_latest == "0009_from_newer_image.sql"


def test_pending_is_computed_by_set_difference():
    applied = ["0000_baseline_adopted.sql", "0001_ledger.sql", "0002_schema.sql"]
    s = evaluate(CODE, applied)
    assert s.state == "behind"
    assert s.pending == ["0003_extra.sql"]


def test_unknown_when_ledger_unavailable():
    s = evaluate(CODE, None)
    assert s.state == "unknown"
    assert s.pending == []
    assert s.applied_latest is None


class _Repo:
    def __init__(self, result=None, exc=None):
        self.calls = 0
        self.result, self.exc = result, exc

    def applied_migrations(self):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.result


def _app(repo):
    return SimpleNamespace(state=SimpleNamespace(repository=repo))


@pytest.fixture
def clock(monkeypatch):
    t = {"now": 1000.0}
    monkeypatch.setattr(schema_gate, "_now", lambda: t["now"])
    return t


def test_ledger_read_is_cached(clock):
    repo = _Repo(result=[])
    app = _app(repo)
    first = read_status(app)
    clock["now"] += 14
    assert read_status(app) is first
    assert repo.calls == 1
    clock["now"] += 2
    read_status(app)
    assert repo.calls == 2


def test_raising_ledger_read_is_unknown_and_cached(clock):
    repo = _Repo(exc=RuntimeError("db down"))
    app = _app(repo)
    assert read_status(app).state == "unknown"
    read_status(app)
    assert repo.calls == 1
