"""What the *production* adapter actually sends (plan 0024 M2/M4).

Every other test in `apps/cloud/tests/` runs against `InMemoryRepository`, so
a green suite establishes the behaviour of the double and nothing about
`SupabaseRepository` — the class that runs in production and the one whose
two-call delete-then-insert was half of the defect this plan closes. The
contract suite (`tests/contract/`) covers the other half against real
Postgres, but it skips without a database, so the claim "one RPC, never a bare
delete" needs a case that runs on every `pytest -q`.

This is that case: a recording stand-in for the supabase client, and
assertions about the calls the adapter makes rather than about the state that
results. It deliberately does not build a real client — the repository is
constructed through `__new__` and handed the fake — because the point is the
wire, not a round trip.
"""

from __future__ import annotations

import pytest

from app.db.supabase_repository import SupabaseRepository
from app.models.schemas import utcnow


class _Result:
    def __init__(self, data):
        self.data = data
        self.count = len(data) if isinstance(data, list) else 0


class _QueryRecorder:
    """A PostgREST query builder that records its verb chain instead of
    running it. Every method returns `self`, as the real builder does."""

    def __init__(self, table: str, log: list[str], data):
        self._table = table
        self._log = log
        self._data = data

    def _verb(self, name: str):
        self._log.append(f"{self._table}.{name}")
        return self

    def delete(self):
        return self._verb("delete")

    def insert(self, *_args, **_kwargs):
        return self._verb("insert")

    def upsert(self, *_args, **_kwargs):
        return self._verb("upsert")

    def update(self, payload, *_args, **_kwargs):
        self._log.append(f"{self._table}.update:{sorted(payload)}")
        return self

    def select(self, *_args, **_kwargs):
        return self._verb("select")

    def eq(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        return _Result(self._data)


class _FakeClient:
    def __init__(self, rpc_result=True, table_data=None):
        self.calls: list[str] = []
        self.rpc_args: list[tuple[str, dict]] = []
        self._rpc_result = rpc_result
        self._table_data = table_data if table_data is not None else []

    def table(self, name: str):
        return _QueryRecorder(name, self.calls, self._table_data)

    def rpc(self, name: str, params: dict):
        self.calls.append(f"rpc.{name}")
        self.rpc_args.append((name, params))
        return _QueryRecorder(f"rpc:{name}", [], self._rpc_result)


def _repo(client: _FakeClient) -> SupabaseRepository:
    repo = object.__new__(SupabaseRepository)
    repo._url = "http://localhost"
    repo._key = "k"
    repo._client = client
    repo._service_client = client
    return repo


@pytest.fixture
def client() -> _FakeClient:
    return _FakeClient()


def test_freezing_issues_exactly_one_rpc(client):
    """The atomicity claim, stated as the only thing that can hold it up:
    one call. A delete and an insert as two PostgREST round trips cannot be a
    transaction, whatever the docstring says — and a failure between them
    erased the record of what shipped rather than leaving a stale one."""
    repo = _repo(client)
    assert repo.freeze_deployment_tasks("d1", ["t1", "t2"], utcnow()) is True

    assert client.calls == ["rpc.pw_freeze_deployment_tasks"]
    name, params = client.rpc_args[0]
    assert name == "pw_freeze_deployment_tasks"
    assert params == {"p_deployment_id": "d1", "p_task_ids": ["t1", "t2"]}


def test_freezing_never_issues_a_bare_delete(client):
    """The specific regression. `pw_deployment_tasks` has exactly one writer
    now, and it is the function."""
    repo = _repo(client)
    repo.freeze_deployment_tasks("d1", ["t1"], utcnow())

    assert not any("pw_deployment_tasks" in call for call in client.calls)
    assert not any(call.endswith(".delete") for call in client.calls)


def test_an_empty_set_is_still_one_rpc(client):
    """The old shape returned early before the insert when the list was
    empty, which left the delete unpaired. There is no early return now: an
    empty freeze is a freeze."""
    repo = _repo(client)
    repo.freeze_deployment_tasks("d1", [], utcnow())

    assert client.calls == ["rpc.pw_freeze_deployment_tasks"]
    assert client.rpc_args[0][1]["p_task_ids"] == []


def test_an_already_frozen_row_is_reported_as_not_written():
    """The function returns false when the row was already frozen, and the
    adapter passes that through rather than swallowing it — callers branch on
    it to read the stored set back."""
    client = _FakeClient(rpc_result=False)
    assert _repo(client).freeze_deployment_tasks("d1", ["t1"], utcnow()) is False


def test_clearing_touches_only_the_deployment_row(client):
    """The correction path writes the two attribution columns on
    pw_deployments and nothing else — in particular it must not clear the
    join table, or a failed recompute would destroy the record it was meant
    to improve."""
    client._table_data = [{"id": "d1"}]
    repo = _repo(client)
    assert repo.clear_deployment_attribution("d1") is True

    assert client.calls == ["pw_deployments.update:['attributed_at', 'attribution_state']"]
    assert not any("pw_deployment_tasks" in call for call in client.calls)


def test_clearing_an_unknown_deployment_reports_it():
    client = _FakeClient(table_data=[])
    assert _repo(client).clear_deployment_attribution("nope") is False
