"""SupabaseRepository's stage-inputs methods when migration 0003 is not
applied yet.

Code can reach an environment before its migration does (docs/DEPLOYMENT.md
applies migrations by hand). PostgREST then answers with a "table not found"
error; the adapter must turn that into "no answers" on read and a typed
StageInputsUnavailable on write — never a 500 from the Planner's form load.
Any other failure must still surface. Runs on every `pytest -q` against a
stand-in client, as test_deployment_attribution_adapter.py does.
"""

from __future__ import annotations

import pytest
from postgrest.exceptions import APIError

from app.db.repository import StageInputsUnavailable
from app.db.supabase_repository import _SERVICE_ONLY_TABLES, SupabaseRepository


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client: _Client, table: str):
        self._client = client
        self._table = table

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def upsert(self, payload, **_kwargs):
        self._client.upserts.append((self._table, payload))
        return self

    def execute(self):
        if self._client.error is not None:
            raise APIError(self._client.error)
        return _Result(self._client.rows)


class _Client:
    def __init__(self, error=None, rows=None):
        self.error = error
        self.rows = rows or []
        self.upserts: list[tuple[str, dict]] = []

    def table(self, name: str):
        return _Query(self, name)


def _repo(client: _Client) -> SupabaseRepository:
    repo = object.__new__(SupabaseRepository)
    repo._url = "http://localhost"
    repo._key = "k"
    repo._client = client
    repo._service_client = client
    return repo


MISSING_TABLE = [
    {"code": "PGRST205", "message": "Could not find the table 'public.pw_stage_inputs'"},
    {"code": "42P01", "message": 'relation "pw_stage_inputs" does not exist'},
]


@pytest.mark.parametrize("error", MISSING_TABLE)
def test_a_missing_table_reads_as_no_answers(error):
    assert _repo(_Client(error=error)).get_stage_inputs("p", "specify") is None


@pytest.mark.parametrize("error", MISSING_TABLE)
def test_a_missing_table_refuses_writes_with_a_typed_error(error):
    with pytest.raises(StageInputsUnavailable):
        _repo(_Client(error=error)).upsert_stage_inputs("p", "w", "specify", {"a": "x"}, "u")


def test_any_other_error_still_raises():
    error = {"code": "42501", "message": "permission denied for table pw_stage_inputs"}
    with pytest.raises(APIError):
        _repo(_Client(error=error)).get_stage_inputs("p", "specify")
    with pytest.raises(APIError):
        _repo(_Client(error=error)).upsert_stage_inputs("p", "w", "specify", {"a": "x"}, "u")


def test_the_upsert_targets_the_table_keyed_by_project_and_stage():
    client = _Client()
    saved = _repo(client).upsert_stage_inputs("p", "w", "specify", {"a": "x"}, "u")

    assert saved.inputs == {"a": "x"}
    [(table, payload)] = client.upserts
    assert table == "pw_stage_inputs"
    assert payload["inputs"] == {"a": "x"}
    assert payload["project_id"] == "p"
    assert payload["stage"] == "specify"
    assert payload["updated_by"] == "u"


def test_a_stored_row_parses():
    row = {
        "project_id": "p",
        "workspace_id": "w",
        "stage": "plan",
        "inputs": {"lang": "Go"},
        "updated_by": "u",
        "updated_at": "2026-10-03T00:00:00+00:00",
    }
    got = _repo(_Client(rows=[row])).get_stage_inputs("p", "plan")
    assert got is not None
    assert got.inputs == {"lang": "Go"}


def test_the_table_is_reached_on_the_service_role_client():
    """Migration 0003 revokes it from `authenticated`, so a user-scoped client
    would get `permission denied` rather than the row."""
    assert "pw_stage_inputs" in _SERVICE_ONLY_TABLES
