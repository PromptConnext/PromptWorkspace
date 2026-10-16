"""SupabaseRepository's delivery-store methods when migration 0004 is not
applied yet: reads return nothing, writes raise DeliveryStoreUnavailable,
any other failure still surfaces. Same posture as the stage-inputs store."""

from __future__ import annotations

import pytest
from postgrest.exceptions import APIError

from app.db.repository import DeliveryStoreUnavailable
from app.db.supabase_repository import _SERVICE_ONLY_TABLES, SupabaseRepository
from app.models.schemas import Decision, DeliveryChange, StageDocument


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

    def in_(self, column, values):
        self._client.in_filters.append((self._table, column, list(values)))
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
        self._client.executes += 1
        if self._client.error is not None:
            raise APIError(self._client.error)
        return _Result(self._client.rows)


class _Client:
    def __init__(self, error=None, rows=None):
        self.error = error
        self.rows = rows or []
        self.upserts: list[tuple[str, object]] = []
        self.deletes: list[str] = []
        self.in_filters: list[tuple[str, str, list]] = []
        self.executes = 0

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


MISSING_SNAPSHOTS = {
    "code": "PGRST205",
    "message": "Could not find the table 'public.pw_decision_snapshots'",
}

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

            def execute(self):
                if name == "pw_decision_snapshots":  # pre-0006: no 0008 table either
                    raise APIError(MISSING_SNAPSHOTS)
                return super().execute()

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
    assert client.refused == 2  # the row write, then the legacy re-write after the snapshot miss
    decision_upserts = [p for t, p in client.upserts if t == "pw_decisions"]
    assert decision_upserts[-1]["id"] == DECISION.id
    assert "subject_content" not in decision_upserts[-1]


def test_a_failure_unrelated_to_the_content_column_still_raises_on_save():
    repo = _repo(_Client(error={"code": "42501", "message": "permission denied"}))
    with pytest.raises(APIError):
        repo.save_decision(DECISION.model_copy(update={"subject_content": "x"}))



def test_several_stage_documents_are_one_request():
    rows = [
        StageDocument(project_id="p", workspace_id="w", stage=stage, content=f"# {stage}",
                      created_by="u").model_dump(mode="json")
        for stage in ("specify", "tasks")
    ]
    client = _Client(rows=rows)

    docs = _repo(client).list_stage_documents("p", ["specify", "tasks"])

    assert client.executes == 1
    assert client.in_filters == [("pw_stage_documents", "stage", ["specify", "tasks"])]
    assert {stage: doc.content for stage, doc in docs.items()} == {
        "specify": "# specify", "tasks": "# tasks",
    }


def test_no_stages_asked_for_is_no_request():
    client = _Client()
    assert _repo(client).list_stage_documents("p", []) == {}
    assert client.executes == 0


class _SnapshotWriteClient(_Client):
    """pw_decisions is fine; writes to pw_decision_snapshots fail with `error`."""

    def table(self, name: str):
        client = self

        class _Q(_Query):
            def execute(self):
                if name == "pw_decision_snapshots":
                    raise APIError(client.snapshot_error)
                return super().execute()

        return _Q(self, name)

    snapshot_error: dict = MISSING_SNAPSHOTS


def test_a_missing_snapshot_table_keeps_the_text_on_the_decision_row():
    client = _SnapshotWriteClient()
    saved = _repo(client).save_decision(DECISION.model_copy(update={"subject_content": "# Spec"}))

    assert saved.subject_content == "# Spec"
    contents = [p["subject_content"] for t, p in client.upserts if t == "pw_decisions"]
    assert contents == [None, "# Spec"]


def test_a_failed_snapshot_write_keeps_the_text_and_raises():
    client = _SnapshotWriteClient()
    client.snapshot_error = {"code": "57014", "message": "statement timeout"}
    with pytest.raises(APIError):
        _repo(client).save_decision(DECISION.model_copy(update={"subject_content": "# Spec"}))

    contents = [p["subject_content"] for t, p in client.upserts if t == "pw_decisions"]
    assert contents == [None, "# Spec"]


def test_listing_decisions_reads_snapshots_by_project_not_by_every_id():
    row = {**DECISION.model_dump(mode="json"), "decision_id": DECISION.id, "content": "# Spec"}
    client = _Client(rows=[row])
    decisions = _repo(client).list_decisions("p")

    assert client.in_filters == []  # no URL that grows with the history
    assert decisions[0].subject_content == "# Spec"
