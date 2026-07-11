"""RAG assistant v1 chat (M9) — the milestone's exit criteria:

  1. A member asks a question and gets a correct, cited answer using only
     their workspace's model key.
  2. A member of another workspace provably cannot retrieve those chunks —
     tested at the repository layer (the structural equivalent of RLS for the
     in-memory backend; Postgres RLS itself is added in migrations/0009_rag.sql
     and, per this repo's convention, verified by running against a real
     Supabase instance rather than in pytest — see README's migrations note).
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

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


def _setup_workspace_with_requirement(client: TestClient, user_headers: dict, req_id: str):
    ws = client.post("/workspaces", json={"name": "W"}, headers=user_headers).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=user_headers
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
        headers=user_headers,
    )
    assert conn.status_code == 200, conn.text
    push = client.put(
        f"/sync/projects/{project['id']}/graph",
        json={
            "requirements": [
                {
                    "id": req_id,
                    "project_id": project["id"],
                    "title": "Payments requirement",
                    "description": "Acceptance: supports one-time and subscription charges.",
                }
            ]
        },
        headers=user_headers,
    )
    assert push.status_code == 200, push.text

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(
        lambda: len(repo.vector_search(ws["id"], project["id"], zero_vector, top_k=10)) > 0
    )
    return ws["id"], project["id"]


def _parse_sse_citations(body: str) -> list[dict]:
    for block in body.split("\n\n"):
        if block.startswith("event: citations"):
            data_line = next(line for line in block.splitlines() if line.startswith("data:"))
            return json.loads(data_line[len("data:") :].strip())["citations"]
    raise AssertionError(f"no citations event in SSE body: {body!r}")


def _parse_sse_answer(body: str) -> str:
    deltas = []
    for block in body.split("\n\n"):
        if block.startswith("data:") and "delta" in block:
            deltas.append(json.loads(block[len("data:") :].strip())["delta"])
    return "".join(deltas)


def test_chat_returns_answer_grounded_with_citations(client: TestClient):
    ws_id, pid = _setup_workspace_with_requirement(client, ALICE, "r1")

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What are the payments acceptance criteria?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    answer = _parse_sse_answer(res.text)
    assert "Based on the context" in answer  # FakeChatProvider's grounded answer
    assert "requirements:r1" in answer  # the retrieved chunk's citation marker

    citations = _parse_sse_citations(res.text)
    assert citations, "expected at least one citation"
    assert citations[0]["node_type"] == "requirements"
    assert citations[0]["node_id"] == "r1"


def test_chat_requires_model_connection(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    res = client.post(
        f"/projects/{project['id']}/assistant/chat",
        json={"question": "anything"},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "model_connection_not_configured"


def test_other_workspace_member_cannot_reach_project(client: TestClient):
    _ws_a, pid_a = _setup_workspace_with_requirement(client, ALICE, "r1")
    # bob is a member of a different workspace entirely.
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)

    res = client.post(
        f"/projects/{pid_a}/assistant/chat", json={"question": "x"}, headers=BOB
    )
    assert res.status_code == 403


def test_vector_search_is_scoped_to_workspace_and_project(client: TestClient):
    """Repository-layer proof: even given workspace A's own project_id, a
    query scoped to workspace B's workspace_id retrieves nothing — the
    explicit predicate (ADR 0011) rejects a workspace_id/project_id mismatch
    outright, before any similarity ranking runs."""
    ws_a_id, pid_a = _setup_workspace_with_requirement(client, ALICE, "r1")
    ws_b = client.post("/workspaces", json={"name": "W-B"}, headers=BOB).json()

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert len(repo.vector_search(ws_a_id, pid_a, zero_vector, top_k=10)) > 0
    assert repo.vector_search(ws_b["id"], pid_a, zero_vector, top_k=10) == []
