"""Stage regeneration keeps a stable identity (plan 0018).

Both ways of changing a stage — generating it and editing the raw markdown —
go through app/generation/stage_apply.py, so regenerating `tasks` reconciles
the board it already has instead of laying a second generation on top of it.
What that has to be true of: no `T###` ever resolves to two live tasks
(app/integrations/task_refs.py::colliding_refs is what commit attribution
loses to), a task a regeneration drops is tombstoned with its status,
assignee and evidence intact, and a hand edit reports honestly whether the
board moved.
"""

from __future__ import annotations

import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.integrations.task_refs import colliding_refs, tasks_by_ref
from app.main import create_app
from app.models.schemas import ArtifactKind, ModelConnection, TaskStatus, utcnow
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}

SPECIFY_INPUT = "Support the new payments rollout across every region we operate in."
PLAN_INPUT = "Plan out the technical implementation for the payments rollout in detail."
TASKS_INPUT = "Break the approved implementation plan into small, shippable tasks."

THREE_TASKS = (
    "# Tasks\n\n"
    "Enough prose here for the document parser's minimum-length check to accept this as a "
    "real generated document rather than a token stub.\n\n"
    "- [ ] T001 [P] Add the payment intent endpoint\n"
    "- [ ] T002 Persist the payment record\n"
    "- [ ] T003 Reconcile settlements nightly\n"
)

TWO_TASKS = (
    "# Tasks\n\n"
    "Enough prose here for the document parser's minimum-length check to accept this as a "
    "real generated document rather than a token stub.\n\n"
    "- [ ] T001 [P] Add the payment intent endpoint\n"
    "- [ ] T002 Persist the payment record\n"
)


class _StubProvider:
    """Returns a fixed document, so a test can decide exactly which checklist
    a generation produces — including the same one twice."""

    def __init__(self, body: str) -> None:
        self.body = body

    async def stream(
        self,
        system_prompt,
        user_content,
        model,
        api_key,
        base_url,
        max_tokens=None,
        on_finish=None,
    ):
        yield self.body
        if on_finish is not None:
            on_finish("stop")


def _managed_connection() -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url="https://api.opentyphoon.ai/v1",
        model="typhoon-v2.5-30b-a3b-instruct",
        embed_model="",
        embed_dim=0,
        secret_ref="unused-in-these-tests",
        daily_token_budget=200_000,
        created_by="platform",
        source="managed",
    )


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.managed_connection = _managed_connection()
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


def _bootstrap(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return project["id"]


def _generate(client: TestClient, pid: str, stage: str, user_input: str, body: str):
    client.app.state.generation_provider = _StubProvider(body)
    return client.post(
        f"/projects/{pid}/generate/{stage}",
        json={"user_input": user_input},
        headers=ALICE,
    )


def _done(res) -> dict:
    """The last `done` payload in an SSE response body."""
    payload: dict = {}
    event = "message"
    for line in res.text.splitlines():
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:") and event == "done":
            payload = json.loads(line[len("data:") :].strip())
    return payload


def _planned(client: TestClient, pid: str) -> None:
    """The two stages `tasks` gates on, generated with throwaway bodies."""
    spec_body = (
        "# Payments rollout\n\nA specification long enough for the parser's minimum-length "
        "check to treat it as a real document.\n"
    )
    _generate(client, pid, "specify", SPECIFY_INPUT, spec_body)
    plan_body = (
        "# Payments plan\n\nA technical plan long enough for the parser's minimum-length "
        "check to treat it as a real document.\n"
    )
    _generate(client, pid, "plan", PLAN_INPUT, plan_body)


def _live_tasks(client: TestClient, pid: str) -> list:
    return client.app.state.repository.get_graph(pid).tasks


def test_regenerating_tasks_reuses_the_same_rows_and_collides_with_nothing(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)

    first = _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)
    assert first.status_code == 200, first.text
    assert _done(first)["task_count"] == 3
    before = {t.feature_tag: t.id for t in _live_tasks(client, pid)}
    assert len(before) == 3

    second = _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)
    assert second.status_code == 200, second.text
    assert _done(second)["task_count"] == 3

    tasks = _live_tasks(client, pid)
    assert colliding_refs(t.feature_tag for t in tasks) == set()
    by_ref = tasks_by_ref(tasks)
    assert sorted(by_ref) == ["T1", "T2", "T3"]
    # Every ref resolves to exactly one task, and it is the *same* task the
    # first generation created — the whole point of matching by reference.
    assert {t.feature_tag: t.id for t in tasks} == before
    assert len(tasks) == 3


def test_a_dropped_task_is_tombstoned_with_its_status_assignee_and_evidence(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)

    repo = client.app.state.repository
    retired = next(t for t in _live_tasks(client, pid) if t.feature_tag == "T003")
    repo.assign_task(pid, retired.id, "alice", utcnow())
    repo.set_task_status(pid, retired.id, TaskStatus.implemented, utcnow())
    artifact = repo.upsert_task_artifact(
        pid, retired.id, "https://example.test/commit/abc", "abc", ArtifactKind.code, utcnow()
    )

    res = _generate(client, pid, "tasks", TASKS_INPUT, TWO_TASKS)
    assert res.status_code == 200, res.text
    assert _done(res)["task_count"] == 2

    # test-only reach into InMemoryRepository internals: the tombstoned row is
    # invisible to get_graph by design, and that invisibility is the assertion
    # two lines below.
    row = repo._graph[pid]["tasks"][retired.id]
    assert row.deleted_at is not None
    assert row.status == TaskStatus.implemented
    assert row.assigned_user_id == "alice"

    graph = repo.get_graph(pid)  # bootstrap pull: since=None
    assert retired.id not in {t.id for t in graph.tasks}
    assert sorted(t.feature_tag for t in graph.tasks) == ["T001 [P]", "T002"]

    # Evidence is history: an Artifact keys on task_id, not on the task being
    # live, so retirement must never touch it.
    stored_artifact = repo._graph[pid]["artifacts"][artifact.id]
    assert stored_artifact.deleted_at is None
    assert stored_artifact.task_id == retired.id
    assert stored_artifact.commit_sha == "abc"


def test_a_preexisting_reference_collision_is_consolidated_not_perpetuated(client: TestClient):
    """A project that regenerated `tasks` before this path existed can have two
    live rows sharing one T### reference. Regenerating again must consolidate
    them into one live row and tombstone the rest, not leave the collision
    standing forever."""
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)

    repo = client.app.state.repository
    original = next(t for t in _live_tasks(client, pid) if t.feature_tag == "T001 [P]")
    # `get_graph` orders candidates by (updated_at, id) ascending, and
    # `_apply_tasks` keeps whichever row it sees first for a reference —
    # so the duplicate needs a strictly later `updated_at` than `original`
    # to make it deterministically the one retired below. A shared
    # `updated_at` (e.g. from a bare `model_copy`) leaves the tie broken by
    # `id` string comparison against a random uuid4, which flips this
    # test's outcome depending on which id happens to sort first.
    duplicate = original.model_copy(
        update={
            "id": "dup-t1",
            "title": "A stray duplicate of T1",
            "feature_tag": "T001",
            "updated_at": original.updated_at + timedelta(seconds=1),
        }
    )
    repo._graph[pid]["tasks"][duplicate.id] = duplicate
    assert colliding_refs(t.feature_tag for t in _live_tasks(client, pid)) == {"T1"}

    res = _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)
    assert res.status_code == 200, res.text
    payload = _done(res)
    assert payload["task_count"] == 3
    assert payload["retired_count"] == 1

    tasks = _live_tasks(client, pid)
    assert colliding_refs(t.feature_tag for t in tasks) == set()
    by_ref = tasks_by_ref(tasks)
    assert sorted(by_ref) == ["T1", "T2", "T3"]
    assert duplicate.id not in {t.id for t in tasks}
    assert repo._graph[pid]["tasks"][duplicate.id].deleted_at is not None


def test_a_hand_edited_tasks_document_that_parses_reports_current(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)
    before = {t.feature_tag: t.id for t in _live_tasks(client, pid)}

    edited = THREE_TASKS.replace("Persist the payment record", "Persist the payment ledger")
    res = client.patch(
        f"/projects/{pid}/stage-documents/tasks", json={"content": edited}, headers=ALICE
    )

    assert res.status_code == 200, res.text
    assert res.json()["projection"] == "current"
    tasks = _live_tasks(client, pid)
    assert {t.feature_tag: t.id for t in tasks} == before
    edited_task = next(t for t in tasks if t.feature_tag == "T002")
    assert edited_task.title == "Persist the payment ledger"
    assert edited_task.acceptance_criteria == []
    assert client.app.state.repository.get_stage_document(pid, "tasks").content == edited


def test_a_hand_edited_tasks_document_that_does_not_parse_reports_failed(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)
    before = {(t.id, t.feature_tag, t.title) for t in _live_tasks(client, pid)}

    prose = "# Tasks\n\nProse with no checklist lines at all — nothing for the parser to find.\n"
    res = client.patch(
        f"/projects/{pid}/stage-documents/tasks", json={"content": prose}, headers=ALICE
    )

    assert res.status_code == 200, res.text
    assert res.json()["projection"] == "failed"
    # The save guarantee this endpoint has always made: the text survives even
    # when the graph rejects it.
    assert client.app.state.repository.get_stage_document(pid, "tasks").content == prose
    assert {(t.id, t.feature_tag, t.title) for t in _live_tasks(client, pid)} == before


TASKS_WITH_AC = (
    "# Tasks\n\n"
    "Enough prose here for the document parser's minimum-length check to accept this as a "
    "real generated document rather than a token stub.\n\n"
    "- [ ] T001 [P] Add the payment intent endpoint\n"
    "  - AC: POST /payment-intents returns 201 with the intent id\n"
    "  - AC: An unknown currency is rejected with 422\n"
    "- [ ] T002 Persist the payment record\n"
)


def test_tasks_store_the_checklist_acceptance_criteria_not_the_title(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)

    res = _generate(client, pid, "tasks", TASKS_INPUT, TASKS_WITH_AC)
    assert res.status_code == 200, res.text

    by_tag = {t.feature_tag: t for t in _live_tasks(client, pid)}
    assert [c.model_dump() for c in by_tag["T001 [P]"].acceptance_criteria] == [
        {"text": "POST /payment-intents returns 201 with the intent id"},
        {"text": "An unknown currency is rejected with 422"},
    ]
    assert by_tag["T002"].acceptance_criteria == []


def test_regenerating_tasks_updates_criteria_on_the_existing_rows(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, TASKS_WITH_AC)
    before = {t.feature_tag: t.id for t in _live_tasks(client, pid)}

    regenerated = TASKS_WITH_AC.replace(
        "  - AC: An unknown currency is rejected with 422\n", ""
    ).replace(
        "- [ ] T002 Persist the payment record\n",
        "- [ ] T002 Persist the payment record\n  - AC: The record survives a restart\n",
    )
    res = _generate(client, pid, "tasks", TASKS_INPUT, regenerated)
    assert res.status_code == 200, res.text

    tasks = _live_tasks(client, pid)
    assert {t.feature_tag: t.id for t in tasks} == before
    by_tag = {t.feature_tag: t for t in tasks}
    assert [c.text for c in by_tag["T001 [P]"].acceptance_criteria] == [
        "POST /payment-intents returns 201 with the intent id"
    ]
    assert [c.text for c in by_tag["T002"].acceptance_criteria] == ["The record survives a restart"]


def test_ac_lines_added_by_hand_in_the_planner_editor_land_on_the_task(client: TestClient):
    pid = _bootstrap(client)
    _planned(client, pid)
    _generate(client, pid, "tasks", TASKS_INPUT, THREE_TASKS)

    edited = THREE_TASKS.replace(
        "- [ ] T002 Persist the payment record\n",
        "- [ ] T002 Persist the payment record\n  * AC: A duplicate payment id is rejected\n",
    )
    res = client.patch(
        f"/projects/{pid}/stage-documents/tasks", json={"content": edited}, headers=ALICE
    )

    assert res.status_code == 200, res.text
    task = next(t for t in _live_tasks(client, pid) if t.feature_tag == "T002")
    assert [c.text for c in task.acceptance_criteria] == ["A duplicate payment id is rejected"]
