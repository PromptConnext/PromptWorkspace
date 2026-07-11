"""Golden-question eval harness (M10) — the milestone's own exit criterion:
"eval set passes; a status question ('is requirement X done?') returns
graph-exact data, verified by test."

One fixture project seeded via the normal sync push, covering all four
categories the milestone names: lineage, content, cross-artifact,
permission-boundary. Runs against the same FakeEmbeddingProvider/
FakeChatProvider wiring as test_rag_chat.py — deterministic, no network,
plain `pytest` (also selectable via `pytest -m eval`).
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

pytestmark = pytest.mark.eval

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _parse_sse(body: str, event: str) -> dict | None:
    for block in body.split("\n\n"):
        lines = block.splitlines()
        if event == "message":
            is_match = lines and lines[0].startswith("data:") and not any(
                line.startswith("event:") for line in lines
            )
        else:
            is_match = any(line == f"event: {event}" for line in lines)
        if not is_match:
            continue
        data_line = next((line for line in lines if line.startswith("data:")), None)
        if data_line:
            return json.loads(data_line[len("data:") :].strip())
    return None


def _parse_sse_answer(body: str) -> str:
    deltas = []
    for block in body.split("\n\n"):
        if block.startswith("data:") and "delta" in block:
            deltas.append(json.loads(block[len("data:") :].strip())["delta"])
    return "".join(deltas)


@pytest.fixture
def fixture_project(client: TestClient) -> tuple[str, str]:
    """Two requirements — one fully done, one partially done — with specs,
    tasks across statuses, an artifact, and an agent run."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    conn = client.post(
        f"/workspaces/{ws['id']}/model-connection",
        json={
            "provider": "openai",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-x",
            "embed_model": "embed-x",
            "api_key": "sk-test",
        },
        headers=ALICE,
    )
    assert conn.status_code == 200, conn.text

    pid = project["id"]
    push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r-payments",
                    "project_id": pid,
                    "title": "Payments requirement",
                    "description": "Supports one-time and subscription charges.",
                    "status": "approved",
                },
                {
                    "id": "r-onboarding",
                    "project_id": pid,
                    "title": "Onboarding requirement",
                    "description": "New user signup flow.",
                    "status": "draft",
                },
            ],
            "spec_documents": [
                {
                    "id": "s-payments",
                    "project_id": pid,
                    "requirement_id": "r-payments",
                    "content": "spec",
                },
                {
                    "id": "s-onboarding",
                    "project_id": pid,
                    "requirement_id": "r-onboarding",
                    "content": "spec",
                },
            ],
            "tasks": [
                {
                    "id": "t-login",
                    "project_id": pid,
                    "spec_id": "s-payments",
                    "title": "Build login form",
                    "status": "implemented",
                    "acceptance_criteria": [{"text": "shows error on bad credentials"}],
                },
                {
                    "id": "t-charge",
                    "project_id": pid,
                    "spec_id": "s-payments",
                    "title": "Charge card on file",
                    "status": "verified",
                },
                {
                    "id": "t-wizard",
                    "project_id": pid,
                    "spec_id": "s-onboarding",
                    "title": "Build onboarding wizard",
                    "status": "todo",
                },
                {
                    "id": "t-welcome",
                    "project_id": pid,
                    "spec_id": "s-onboarding",
                    "title": "Send welcome email",
                    "status": "in_progress",
                },
            ],
            "artifacts": [
                {"id": "art-login", "project_id": pid, "task_id": "t-login", "uri": "src/login.ts"}
            ],
            "agent_runs": [
                {"id": "run-login", "project_id": pid, "task_id": "t-login", "status": "succeeded"}
            ],
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(
        lambda: len(repo.vector_search(ws["id"], pid, zero_vector, top_k=20)) >= 4
    ), "embeddings did not finish indexing in time"

    return ws["id"], pid


def _ask(client: TestClient, project_id: str, question: str):
    return client.post(
        f"/projects/{project_id}/assistant/chat", json={"question": question}, headers=ALICE
    )


def test_lineage_question_returns_graph_exact_data(
    client: TestClient, fixture_project: tuple[str, str]
):
    """The milestone's own named exit criterion."""
    _ws_id, pid = fixture_project
    res = _ask(client, pid, "Is the payments requirement done?")
    assert res.status_code == 200, res.text

    facts = _parse_sse(res.text, "facts")
    assert facts is not None, "expected a facts event for a lineage question"
    assert facts["scope"] == "requirement"
    assert facts["node_id"] == "r-payments"
    assert facts["status"] == "approved"
    assert facts["tasks_total"] == 2
    assert facts["tasks_done"] == 2  # t-login implemented, t-charge verified — exact
    assert facts["task_status_counts"] == {"implemented": 1, "verified": 1}

    citations = _parse_sse(res.text, "citations")["citations"]
    graph_citations = [c for c in citations if c["source"] == "graph"]
    assert graph_citations and graph_citations[0]["node_id"] == "r-payments"


def test_lineage_question_on_partial_requirement(
    client: TestClient, fixture_project: tuple[str, str]
):
    _ws_id, pid = fixture_project
    res = _ask(client, pid, "Is the onboarding requirement done?")
    facts = _parse_sse(res.text, "facts")
    assert facts["node_id"] == "r-onboarding"
    assert facts["tasks_total"] == 2
    assert facts["tasks_done"] == 0  # todo + in_progress — neither is done


def test_content_question_uses_vector_search(client: TestClient, fixture_project: tuple[str, str]):
    _ws_id, pid = fixture_project
    res = _ask(client, pid, "Explain the login acceptance criteria")
    assert res.status_code == 200, res.text

    assert _parse_sse(res.text, "facts") is None, "content question should not trigger a graph walk"
    citations = _parse_sse(res.text, "citations")["citations"]
    assert citations, "expected at least one vector citation"
    assert all(c["source"] == "vector" for c in citations)
    assert any(c["node_id"] == "t-login" for c in citations)


def test_cross_artifact_question_resolves_task_scope(
    client: TestClient, fixture_project: tuple[str, str]
):
    _ws_id, pid = fixture_project
    res = _ask(client, pid, "Is the login form task done, and what artifacts back it?")

    facts = _parse_sse(res.text, "facts")
    assert facts["scope"] == "task"
    assert facts["node_id"] == "t-login"
    assert facts["artifacts_total"] == 1
    assert facts["agent_runs"] == [{"id": "run-login", "status": "succeeded"}]


def test_mixed_question_returns_both_facts_and_vector_citations(
    client: TestClient, fixture_project: tuple[str, str]
):
    _ws_id, pid = fixture_project
    question = (
        "Is the payments requirement done, and why did we design the login form this way?"
    )
    res = _ask(client, pid, question)
    facts = _parse_sse(res.text, "facts")
    assert facts is not None and facts["node_id"] == "r-payments"

    citations = _parse_sse(res.text, "citations")["citations"]
    assert any(c["source"] == "graph" for c in citations)
    assert any(c["source"] == "vector" for c in citations)


def test_permission_boundary_rejects_lineage_question_from_other_workspace(
    fixture_project: tuple[str, str], client: TestClient
):
    """The new graph-walk path must inherit require_project's membership
    gate, not just the pre-existing vector-search path."""
    _ws_id, pid = fixture_project
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Is the payments requirement done?"},
        headers=BOB,
    )
    assert res.status_code == 403
