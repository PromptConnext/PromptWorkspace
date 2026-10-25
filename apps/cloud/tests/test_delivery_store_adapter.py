"""SupabaseRepository's delivery-store methods when migration 0004 is not
applied yet: reads return nothing, writes raise DeliveryStoreUnavailable,
any other failure still surfaces. Same posture as the stage-inputs store."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from postgrest.exceptions import APIError

from app.db.repository import DeliveryStoreUnavailable
from app.db.supabase_repository import _SERVICE_ONLY_TABLES, SupabaseRepository
from app.models.schemas import (
    Decision,
    DeliveryChange,
    ProjectRole,
    RepoAnalysis,
    RepoSnapshot,
    StageDocument,
)


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

    @property
    def not_(self):
        return self

    def in_(self, column, values):
        self._client.in_filters.append((self._table, column, list(values)))
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, *_a, **_k):
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


def test_workspace_governance_is_service_only():
    # Migration 0011 enables RLS with no policy for `authenticated`; a per-user
    # client would get 42501 on every read.
    assert "pw_workspace_governance" in _SERVICE_ONLY_TABLES


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

    # Filtered by project only: no URL that grows with the history.
    snapshot_filters = [f for f in client.in_filters if f[0] == "pw_decision_snapshots"]
    assert snapshot_filters == [("pw_decision_snapshots", "project_id", ["p"])]
    assert decisions[0].subject_content == "# Spec"


# --- batched reads (plan 0033 task 22) -------------------------------------


def _rpc_error(code: str, message: str) -> APIError:
    """The real postgrest error, so detection is pinned to its actual shape."""
    return APIError({"code": code, "message": message, "hint": None, "details": None})


class _TableClient(_Client):
    """Rows per table, a record of which tables were read, and a scriptable rpc."""

    def __init__(self, rows_by_table=None, rpc_rows=None, rpc_error=None):
        super().__init__()
        self.rows_by_table = rows_by_table or {}
        self.reads: list[str] = []
        self.rpc_rows = rpc_rows or []
        self.rpc_error = rpc_error
        self.rpc_calls: list[tuple[str, dict]] = []

    def table(self, name: str):
        client = self

        class _Q(_Query):
            def execute(self):
                client.reads.append(name)
                return _Result(client.rows_by_table.get(name, []))

        return _Q(self, name)

    def rpc(self, name: str, params: dict):
        client = self
        client.rpc_calls.append((name, params))

        class _Call:
            def execute(self):
                if client.rpc_error is not None:
                    raise client.rpc_error
                return _Result(client.rpc_rows)

        return _Call()


def test_latest_receipt_at_is_one_rpc_and_no_table_read():
    client = _TableClient(rpc_rows=[
        {"project_id": "a", "created_at": "2026-10-01T00:00:00+00:00"},
        {"project_id": "b", "created_at": "2026-10-02T00:00:00+00:00"},
    ])
    got = _repo(client).latest_receipt_at(["a", "b", "c"])

    assert client.rpc_calls == [("pw_latest_receipt_at", {"p_project_ids": ["a", "b", "c"]})]
    assert client.reads == []
    assert set(got) == {"a", "b"}
    assert got["b"].day == 2


@pytest.mark.parametrize(
    "error",
    [
        _rpc_error("42883", "function public.pw_latest_receipt_at(uuid[]) does not exist"),
        _rpc_error(
            "PGRST202",
            "Could not find the function public.pw_latest_receipt_at(project_ids) "
            "in the schema cache",
        ),
    ],
)
def test_latest_receipt_at_falls_back_to_the_paged_read(error):
    rows = [  # newest first, as the query orders them
        {"project_id": "a", "created_at": "2026-10-03T00:00:00+00:00"},
        {"project_id": "a", "created_at": "2026-10-01T00:00:00+00:00"},
        {"project_id": "b", "created_at": "2026-10-02T00:00:00+00:00"},
    ]
    client = _TableClient(rows_by_table={"pw_receipts": rows}, rpc_error=error)

    got = _repo(client).latest_receipt_at(["a", "b"])

    assert len(client.rpc_calls) == 1
    assert client.reads == ["pw_receipts"]
    assert {k: v.day for k, v in got.items()} == {"a": 3, "b": 2}


def _split_repo(user: _Client, service: _Client) -> SupabaseRepository:
    """A per-user repository: `_client` is the caller's scoped client."""
    repo = _repo(user)
    repo._service_client = service
    return repo


def test_latest_receipt_at_calls_the_rpc_on_the_service_client():
    """Migration 0013 grants the function to service_role only, so the call on
    the caller's scoped client would fail with 42501 in supabase auth mode."""
    user = _TableClient()
    service = _TableClient(rpc_rows=[
        {"project_id": "a", "created_at": "2026-10-01T00:00:00+00:00"},
    ])
    got = _split_repo(user, service).latest_receipt_at(["a"])

    assert service.rpc_calls == [("pw_latest_receipt_at", {"p_project_ids": ["a"]})]
    assert user.rpc_calls == []
    assert set(got) == {"a"}


def test_latest_receipt_at_fallback_reads_the_paged_table_on_the_service_client():
    # Function not deployed yet: the paged fallback still reads via `_table`
    # (pw_receipts is service-only) and still gives the per-project max.
    rows = [
        {"project_id": "a", "created_at": "2026-10-03T00:00:00+00:00"},
        {"project_id": "a", "created_at": "2026-10-01T00:00:00+00:00"},
        {"project_id": "b", "created_at": "2026-10-02T00:00:00+00:00"},
    ]
    user = _TableClient()
    service = _TableClient(
        rows_by_table={"pw_receipts": rows},
        rpc_error=_rpc_error("PGRST202", "Could not find the function public.pw_latest_receipt_at"),
    )
    got = _split_repo(user, service).latest_receipt_at(["a", "b"])

    assert user.rpc_calls == [] and user.reads == []
    assert len(service.rpc_calls) == 1
    assert service.reads == ["pw_receipts"]
    assert {k: v.day for k, v in got.items()} == {"a": 3, "b": 2}


def test_latest_receipt_at_other_rpc_errors_still_raise():
    client = _TableClient(rpc_error=_rpc_error("57014", "canceling statement due to timeout"))
    with pytest.raises(APIError):
        _repo(client).latest_receipt_at(["a"])
    assert client.reads == []


def test_list_decisions_for_is_one_decision_read_and_one_snapshot_read():
    older = DECISION.model_copy(update={"id": "d1", "project_id": "a"})
    newer = DECISION.model_copy(update={"id": "d2", "project_id": "a"})
    other = DECISION.model_copy(update={"id": "d3", "project_id": "b"})
    rows = [d.model_dump(mode="json") for d in (newer, older, other)]  # newest first
    client = _TableClient(rows_by_table={
        "pw_decisions": rows,
        "pw_decision_snapshots": [{"decision_id": "d2", "content": "# Spec"}],
    })

    got = _repo(client).list_decisions_for(["a", "b", "c"])

    assert client.reads == ["pw_decisions", "pw_decision_snapshots"]
    assert client.in_filters == [
        ("pw_decisions", "project_id", ["a", "b", "c"]),
        ("pw_decision_snapshots", "project_id", ["a", "b", "c"]),
    ]
    assert set(got) == {"a", "b", "c"}
    assert [d.id for d in got["a"]] == ["d2", "d1"]
    assert got["a"][0].subject_content == "# Spec"
    assert [d.id for d in got["b"]] == ["d3"]
    assert got["c"] == []


def test_list_project_roles_for_is_one_read_grouped_by_project():
    def role(pid, hat):
        return ProjectRole(
            project_id=pid, workspace_id="w", hat=hat, user_id="u", assigned_by="x"
        ).model_dump(mode="json")

    client = _TableClient(rows_by_table={
        "pw_project_roles": [role("a", "business_owner"), role("a", "tech_steward"),
                             role("b", "business_owner")],
    })

    got = _repo(client).list_project_roles_for(["a", "b", "c"])

    assert client.reads == ["pw_project_roles"]
    assert client.in_filters == [("pw_project_roles", "project_id", ["a", "b", "c"])]
    assert [r.hat for r in got["a"]] == ["business_owner", "tech_steward"]
    assert len(got["b"]) == 1
    assert got["c"] == []


def test_get_repo_analyses_is_one_read_with_only_present_keys():
    row = RepoAnalysis(
        project_id="a", workspace_id="w", commit_sha="c" * 40,
        snapshot=RepoSnapshot(commit_sha="c" * 40, default_branch="main", file_count=0),
        created_by="u",
    ).model_dump(mode="json")
    client = _TableClient(rows_by_table={"pw_repo_analyses": [row]})

    got = _repo(client).get_repo_analyses(["a", "b"])

    assert client.reads == ["pw_repo_analyses"]
    assert client.in_filters == [("pw_repo_analyses", "project_id", ["a", "b"])]
    assert set(got) == {"a"}
    assert _repo(_TableClient()).get_repo_analyses([]) == {}


def test_list_receipts_for_is_one_receipt_read_with_in_filter():
    def row(pid, seq):
        return {
            "id": f"{pid}{seq}", "project_id": pid, "workspace_id": "w", "event": "role.assigned",
            "subject_type": "decision", "subject_id": "s", "actor": "a", "body": {},
            "seq": seq, "prev_hash": "", "hash": "h", "created_at": "2026-10-01T00:00:00+00:00",
        }

    rows = [row("a", 1), row("a", 2), row("b", 1)]
    client = _TableClient(rows_by_table={"pw_receipts": rows})

    got = _repo(client).list_receipts_for(["a", "b", "c"])

    assert client.reads == ["pw_receipts"]
    assert client.in_filters == [("pw_receipts", "project_id", ["a", "b", "c"])]
    assert [r.seq for r in got["a"]] == [1, 2]
    assert [r.seq for r in got["b"]] == [1]
    assert got["c"] == []


def test_list_receipts_for_missing_table_gives_empty_chains():
    client = _Client(error={"code": "42P01", "message": "relation does not exist"})
    assert _repo(client).list_receipts_for(["a"]) == {"a": []}


def test_list_tasks_summary_agent_closed_at_is_the_latest_agent_artifact():
    task = {"project_id": "p", "status": "todo", "assigned_user_id": None,
            "updated_at": "2026-10-20T00:00:00+00:00"}
    client = _TableClient(rows_by_table={
        "pw_tasks": [{**task, "id": "A"}, {**task, "id": "B"}],
        "pw_artifacts": [
            {"id": "a1", "task_id": "A", "updated_at": "2026-10-01T00:00:00+00:00"},
            {"id": "a2", "task_id": "A", "updated_at": "2026-10-05T12:00:00+00:00"},
        ],
    })

    got = {r.task_id: r for r in _repo(client).list_tasks_summary(["p"])}

    assert client.reads == ["pw_tasks", "pw_artifacts"]
    assert got["A"].agent_closed is True
    assert got["A"].agent_closed_at == datetime(2026, 10, 5, 12, tzinfo=timezone.utc)
    assert got["A"].agent_closed_at.tzinfo is not None
    assert got["B"].agent_closed is False
    assert got["B"].agent_closed_at is None


def test_freeze_deployment_tasks_calls_the_rpc_on_the_service_client():
    """pw_freeze_deployment_tasks is granted to service_role only (migration
    0002); the re-attribute route hands the repository a per-user client."""
    user = _TableClient()
    service = _TableClient(rpc_rows=[{"ok": True}])
    got = _split_repo(user, service).freeze_deployment_tasks(
        "d1", ["t1", "t2"], datetime(2026, 10, 1, tzinfo=timezone.utc)
    )

    assert service.rpc_calls == [
        ("pw_freeze_deployment_tasks", {"p_deployment_id": "d1", "p_task_ids": ["t1", "t2"]})
    ]
    assert user.rpc_calls == []
    assert got is True
