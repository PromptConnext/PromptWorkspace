"""SupabaseRepository's delivery-store methods when migration 0004 is not
applied yet: reads return nothing, writes raise DeliveryStoreUnavailable,
any other failure still surfaces. Same posture as the stage-inputs store."""

from __future__ import annotations

import pytest
from postgrest.exceptions import APIError

from app.db.repository import DeliveryStoreUnavailable
from app.db.supabase_repository import _SERVICE_ONLY_TABLES, SupabaseRepository
from app.models.schemas import Decision, DeliveryChange


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client: _Client, table: str):
        self._client = client
        self._table = table

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def is_(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def delete(self, *_a, **_k):
        self._client.deletes.append(self._table)
        return self

    def upsert(self, payload, **_k):
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
        self.upserts: list[tuple[str, object]] = []
        self.deletes: list[str] = []

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
    {"code": "PGRST205", "message": "Could not find the table 'public.pw_decisions'"},
    {"code": "42P01", "message": 'relation "pw_decisions" does not exist'},
]

CHANGE = DeliveryChange(
    project_id="p", workspace_id="w", ref="C1", key="setup", title="Setup", kind="setup",
    position=0,
)
DECISION = Decision(
    project_id="p", workspace_id="w", kind="plan_approval", title="Plan",
    subject_stage="tasks", subject_hash="h", routed_hat="tech_steward", requested_by="u",
)


@pytest.mark.parametrize("error", MISSING_TABLE)
def test_missing_tables_read_as_empty(error):
    repo = _repo(_Client(error=error))
    assert repo.list_delivery_changes("p") == []
    assert repo.list_decisions("p") == []
    assert repo.get_decision("p", "d") is None
    assert repo.list_project_roles("p") == []


@pytest.mark.parametrize("error", MISSING_TABLE)
def test_missing_tables_make_writes_unavailable(error):
    repo = _repo(_Client(error=error))
    with pytest.raises(DeliveryStoreUnavailable):
        repo.upsert_delivery_changes("p", [CHANGE])
    with pytest.raises(DeliveryStoreUnavailable):
        repo.save_decision(DECISION)
    with pytest.raises(DeliveryStoreUnavailable):
        repo.set_project_role("p", "w", "tech_steward", "u", "u")


def test_other_errors_still_raise():
    repo = _repo(_Client(error={"code": "42501", "message": "permission denied"}))
    with pytest.raises(APIError):
        repo.list_decisions("p")


def test_clearing_a_role_deletes_and_setting_upserts():
    client = _Client()
    repo = _repo(client)
    repo.set_project_role("p", "w", "tech_steward", None, "u")
    repo.set_project_role("p", "w", "business_owner", "u2", "u")
    assert client.deletes == ["pw_project_roles"]
    table, payload = client.upserts[0]
    assert table == "pw_project_roles"
    assert payload["hat"] == "business_owner" and payload["user_id"] == "u2"


def test_rows_parse_into_models():
    rows = [CHANGE.model_dump(mode="json")]
    (parsed,) = _repo(_Client(rows=rows)).list_delivery_changes("p")
    assert parsed.ref == "C1"


def test_delivery_tables_are_service_only():
    assert {"pw_delivery_changes", "pw_decisions", "pw_project_roles"} <= _SERVICE_ONLY_TABLES


NO_CONTENT_COLUMN = {
    "code": "PGRST204",
    "message": "Could not find the 'subject_content' column of 'pw_decisions' in the schema cache",
}


class _ColumnlessClient(_Client):
    """A database that has migration 0004 but not 0006: a write naming
    `subject_content` is refused, a write without it succeeds."""

    def table(self, name: str):
        client = self

        class _Q(_Query):
            def upsert(self, payload, **kw):
                if "subject_content" in payload:
                    client.refused += 1
                    client.error = NO_CONTENT_COLUMN
                else:
                    client.error = None
                return super().upsert(payload, **kw)

        return _Q(self, name)

    refused = 0


def test_decisions_still_answer_without_the_content_column():
    row = DECISION.model_dump(mode="json")
    row.pop("subject_content")  # a row from a table that has no such column
    client = _ColumnlessClient(rows=[row])
    repo = _repo(client)

    assert [d.id for d in repo.list_decisions("p")] == [DECISION.id]
    assert repo.list_decisions("p")[0].subject_content is None
    assert repo.get_decision("p", DECISION.id).subject_content is None

    saved = repo.save_decision(DECISION.model_copy(update={"subject_content": "# Spec"}))

    assert saved.subject_content == "# Spec"  # the caller still sees what it asked to save
    assert client.refused == 1
    (_, payload) = client.upserts[-1]
    assert "subject_content" not in payload and payload["id"] == DECISION.id


def test_a_failure_unrelated_to_the_content_column_still_raises_on_save():
    repo = _repo(_Client(error={"code": "42501", "message": "permission denied"}))
    with pytest.raises(APIError):
        repo.save_decision(DECISION.model_copy(update={"subject_content": "x"}))

