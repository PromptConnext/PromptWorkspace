"""Editing the planning documents after the repository exists.

Acceptance test for docs/superpowers/specs/2026-10-10-editable-plan-after-
repository-design.md, section 2: at `repo_created` the stage documents stay
editable, an approval is still bound to the hash of its document (so an edit
makes it stale), and `generate/tasks` is not refused and reconciles the board
by the existing rule (update in place, retire the absent, supersede closed
work whose title no longer matches).

The delivery plan approval (`plan_approval`) binds the `tasks` document
(`STAGE_OF` in app/delivery/decisions.py), not the `plan` document, so the
edit that stales it is an edit of the delivery plan itself, by hand or by
regeneration.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.generation.service import FakeGenerationProvider
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import GraphUpsertRequest, ModelConnection, TaskStatus
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider
from tests._repo_docs_helpers import ALICE, _created_project, _write_stage

TASKS_AT_APPROVAL = """# Tasks

Enough prose here for the document parser's minimum-length check to accept this as a
real generated document rather than a token stub.

## Phase 1: Setup
- [ ] T001 Create the storybook project
## Phase 2: User Story 1 - Reader (Priority: P1)
- [ ] T002 Build the story reader screen
- [ ] T003 Add the bedtime timer
"""

TASKS_INPUT = "Break the approved implementation plan into small, independently shippable tasks."


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.generation_provider = FakeGenerationProvider()
        c.app.state.managed_connection = ModelConnection(
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
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


def _states(client: TestClient, pid: str) -> dict[str, str]:
    res = client.get(f"/projects/{pid}/decisions", headers=ALICE)
    assert res.status_code == 200, res.text
    return res.json()["states"]


def _decide(client: TestClient, pid: str, kind: str) -> None:
    requested = client.post(f"/projects/{pid}/decisions", json={"kind": kind}, headers=ALICE)
    assert requested.status_code == 200, requested.text
    resolved = client.post(
        f"/projects/{pid}/decisions/{requested.json()['id']}/resolve",
        json={"outcome": "approved", "rationale": None},
        headers=ALICE,
    )
    assert resolved.status_code == 200, resolved.text


def _generate_tasks(client: TestClient, pid: str) -> dict:
    res = client.post(
        f"/projects/{pid}/generate/tasks", json={"user_input": TASKS_INPUT}, headers=ALICE
    )
    assert res.status_code == 200, res.text
    done: dict = {}
    event = ""
    for line in res.text.splitlines():
        if line.startswith("event:"):
            event = line[len("event:") :].strip()
        elif line.startswith("data:") and event == "done":
            done = json.loads(line[len("data:") :].strip())
    assert done, res.text
    return done


def _live_tasks(client: TestClient, pid: str):
    return {
        t.feature_tag.split()[0]: t
        for t in client.app.state.repository.get_graph(pid).tasks
        if t.deleted_at is None
    }


def _project_at_repo_created_with_approved_plan(client: TestClient) -> str:
    pid = _created_project(client)
    assert client.app.state.repository.get_project(pid).lifecycle_status == "repo_created"
    _write_stage(client, pid, "tasks", TASKS_AT_APPROVAL)
    _decide(client, pid, "intent_approval")
    _decide(client, pid, "plan_approval")
    assert _states(client, pid) == {"intent": "approved", "plan": "approved"}
    return pid


def test_editing_the_delivery_plan_after_the_repository_makes_its_approval_stale(
    client: TestClient,
):
    pid = _project_at_repo_created_with_approved_plan(client)

    _write_stage(
        client, pid, "tasks", TASKS_AT_APPROVAL.replace("bedtime timer", "reading streak")
    )

    assert _states(client, pid)["plan"] == "stale"
    overview = client.get(f"/projects/{pid}/delivery-overview", headers=ALICE).json()
    assert overview["states"]["plan"] == "stale"
    assert overview["plan"]["plan_approval"] == "stale"
    plan_decision = next(d for d in overview["decisions"] if d["kind"] == "plan_approval")
    assert plan_decision["is_current"] is False


def test_editing_the_scope_after_the_repository_makes_the_intent_approval_stale(
    client: TestClient,
):
    pid = _project_at_repo_created_with_approved_plan(client)

    _write_stage(client, pid, "specify", "# Scope\n\nA story-time app for families and schools.\n")

    assert _states(client, pid) == {"intent": "stale", "plan": "approved"}


def test_generating_tasks_after_the_repository_replaces_the_board_and_stales_the_plan(
    client: TestClient,
):
    pid = _project_at_repo_created_with_approved_plan(client)
    # The plan is edited first: that is the whole point of unfreezing it.
    _write_stage(client, pid, "plan", "# Architecture\n\nPlain JavaScript, no framework.\n")
    # T002 is closed work: the regenerated T002 names different work, so the
    # row is superseded rather than reused as "already done".
    repo = client.app.state.repository
    before = _live_tasks(client, pid)
    assert set(before) == {"T001", "T002", "T003"}
    closed = before["T002"].model_copy(update={"status": TaskStatus.implemented})
    repo.upsert_graph(pid, GraphUpsertRequest(tasks=[closed]), source="pz")

    done = _generate_tasks(client, pid)

    assert done["task_count"] == 2
    assert done["retired_count"] >= 1
    after = _live_tasks(client, pid)
    assert set(after) == {"T001", "T002"}  # T003 is absent from the new checklist: retired
    assert after["T001"].id == before["T001"].id  # open work keeps its row, content moves
    assert after["T001"].title.startswith("Implement the first task")
    assert after["T002"].id != before["T002"].id  # closed work, different title: superseded
    assert after["T002"].status == TaskStatus.todo
    # get_graph hides tombstones; read them from the in-memory store, as
    # test_generation.py does.
    gone = {t.id for t in repo._graph[pid]["tasks"].values() if t.deleted_at is not None}
    assert {before["T002"].id, before["T003"].id} <= gone
    # The regenerated delivery plan is a different document than the one approved.
    assert _states(client, pid)["plan"] == "stale"
