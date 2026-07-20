"""Stage generation endpoints (M1, plan 0007) — router-ready, still BYO.

Exit criteria under test: each stage streams a parsed artifact; `specify`
visibly reflects a PRD uploaded in M0 (a fact only present in the uploaded
document appears in the generated spec, via the M0 retrieval payoff);
`specify`/`plan`/`tasks` persist into the project graph (Requirement /
SpecDocument / Task, the last with `{text: str}[]` acceptance criteria —
CLAUDE.md's shape is unchanged); `plan`/`tasks` 409 without their
prerequisite; a non-member is 403; an over-budget workspace is 429; the run
is recorded in generation_runs.
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.generation.service import FakeGenerationProvider
from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

CONSTITUTION_INPUT = "Ship fast, keep it simple, and always write tests before merging any change."
SPECIFY_INPUT = "Support the new payments rollout across every region we currently operate in."
PLAN_INPUT = "Plan out the technical implementation for the payments rollout in detail."
TASKS_INPUT = "Break the approved implementation plan into small, independently shippable tasks."


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.generation_provider = FakeGenerationProvider()
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _bootstrap(client: TestClient, daily_token_budget: int = 200_000) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    conn = client.post(
        f"/workspaces/{ws['id']}/model-connection",
        json={
            "provider": "openai",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-x",
            "embed_model": "embed-x",
            "api_key": "sk-test",
            "daily_token_budget": daily_token_budget,
        },
        headers=ALICE,
    )
    assert conn.status_code == 200, conn.text
    return ws["id"], project["id"]


def _sse_events(body: str) -> dict[str, dict]:
    """Parse the last `data:` payload for each named SSE event out of the
    raw response body."""
    events: dict[str, dict] = {}
    current_event = "message"
    for line in body.splitlines():
        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            payload = line[len("data:") :].strip()
            if payload:
                events[current_event] = json.loads(payload)
    return events


def _generate(client: TestClient, pid: str, stage: str, user_input: str, headers=ALICE):
    return client.post(
        f"/projects/{pid}/generate/{stage}",
        json={"user_input": user_input},
        headers=headers,
    )


def test_constitution_streams_artifact_and_records_run(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", CONSTITUTION_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "content" in events["done"]
    assert events["done"]["content"].startswith("# ")

    repo = client.app.state.repository
    runs = list(repo._generation_runs.values())  # test-only reach into InMemoryRepository internals
    assert any(
        r.workspace_id == ws_id and r.stage == "constitution" and r.status == "succeeded"
        for r in runs
    )


def test_specify_grounds_on_uploaded_document_and_creates_requirement(client: TestClient):
    ws_id, pid = _bootstrap(client)

    upload = client.post(
        f"/projects/{pid}/documents",
        files={
            "file": (
                "prd.md",
                b"# PRD\n\nThe rollout must support the Thai QR payment rail codenamed ZEBRA-PAY.",
                "text/markdown",
            )
        },
        headers=ALICE,
    )
    assert upload.status_code == 201, upload.text
    assert _wait_until(
        lambda: len(
            client.app.state.repository.vector_search(
                ws_id, pid, [0.0] * FakeEmbeddingProvider.dim, top_k=100
            )
        )
        > 0
    )

    res = _generate(client, pid, "specify", SPECIFY_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "ZEBRA-PAY" in events["done"]["content"]

    requirement_id = events["done"]["requirement_id"]
    repo = client.app.state.repository
    requirement = repo.get_latest_requirement(pid)
    assert requirement is not None
    assert requirement.id == requirement_id
    assert requirement.description == SPECIFY_INPUT


def test_plan_requires_a_requirement_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 409


def test_plan_creates_spec_document_against_latest_requirement(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    spec_id = events["done"]["spec_document_id"]

    repo = client.app.state.repository
    spec = repo.get_latest_spec_document(pid)
    assert spec is not None
    assert spec.id == spec_id


def test_tasks_requires_a_spec_document_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 409


def test_tasks_creates_tasks_with_text_acceptance_criteria(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)
    _generate(client, pid, "plan", PLAN_INPUT)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert events["done"]["task_count"] > 0

    repo = client.app.state.repository
    project_store = repo._graph[pid]  # test-only reach into InMemoryRepository internals
    tasks = list(project_store["tasks"].values())
    assert len(tasks) == events["done"]["task_count"]
    for task in tasks:
        assert task.acceptance_criteria
        assert all(hasattr(c, "text") for c in task.acceptance_criteria)


def test_non_member_cannot_generate(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", "hi", headers=BOB)
    assert res.status_code == 403


def test_over_budget_workspace_is_429(client: TestClient):
    _ws_id, pid = _bootstrap(client, daily_token_budget=0)

    res = _generate(client, pid, "constitution", "hi")
    assert res.status_code == 429
