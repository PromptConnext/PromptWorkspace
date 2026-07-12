"""Discussion RAG ingestion (M12): pz discussions embed by default; pmo
(Jira-mirrored) discussions are skipped until the workspace opts in via
rag_index_pmo_discussions; membership scoping applies to discussion chunks
the same as every other RAG-indexed entity."""

from __future__ import annotations

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


@pytest.fixture
def project_with_task(client: TestClient) -> tuple[str, str, str]:
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
        },
        headers=ALICE,
    )
    assert conn.status_code == 200, conn.text
    push = client.put(
        f"/sync/projects/{project['id']}/graph",
        json={
            "requirements": [{"id": "r1", "project_id": project["id"], "title": "Req"}],
            "spec_documents": [
                {"id": "s1", "project_id": project["id"], "requirement_id": "r1", "content": "spec"}
            ],
            "tasks": [
                {"id": "t1", "project_id": project["id"], "spec_id": "s1", "title": "Task 1"}
            ],
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text
    return ws["id"], project["id"], "t1"


def test_pz_discussion_embeds_by_default(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    ws_id, pid, task_id = project_with_task
    res = client.post(
        f"/projects/{pid}/discussions",
        json={
            "parent_node_type": "tasks",
            "parent_node_id": task_id,
            "body": "Native comment text",
        },
        headers=ALICE,
    )
    assert res.status_code == 201, res.text

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(lambda: len(repo.vector_search(ws_id, pid, zero_vector, top_k=10)) > 0)
    hits = repo.vector_search(ws_id, pid, zero_vector, top_k=10)
    assert any(h.node_type == "discussions" for h in hits)


def test_pmo_discussion_is_not_retrievable_until_opted_in(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    ws_id, pid, task_id = project_with_task
    push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d-pmo",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "jira-bot",
                    "body": "Mirrored comment text",
                    "source": "pmo",
                }
            ],
            "source": "pmo",
        },
        headers=ALICE,
    )
    assert push.status_code == 200

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    # Give the queue a real chance to run (it should skip, not error).
    time.sleep(0.2)
    hits = repo.vector_search(ws_id, pid, zero_vector, top_k=10)
    assert not any(h.node_type == "discussions" for h in hits), (
        "opted-out pmo discussion must be unretrievable — this is the milestone's own "
        "exit criterion"
    )


def test_pmo_discussion_becomes_retrievable_after_opt_in(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    ws_id, pid, task_id = project_with_task
    opt_in = client.patch(
        f"/workspaces/{ws_id}", json={"rag_index_pmo_discussions": True}, headers=ALICE
    )
    assert opt_in.status_code == 200, opt_in.text
    assert opt_in.json()["rag_index_pmo_discussions"] is True

    push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d-pmo-2",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "jira-bot",
                    "body": "Mirrored comment, now opted in",
                    "source": "pmo",
                }
            ],
            "source": "pmo",
        },
        headers=ALICE,
    )
    assert push.status_code == 200

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(
        lambda: any(
            h.node_type == "discussions"
            for h in repo.vector_search(ws_id, pid, zero_vector, top_k=10)
        )
    )


def test_discussion_chunks_are_membership_scoped(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    ws_id, pid, task_id = project_with_task
    res = client.post(
        f"/projects/{pid}/discussions",
        json={"parent_node_type": "tasks", "parent_node_id": task_id, "body": "Secret-ish comment"},
        headers=ALICE,
    )
    assert res.status_code == 201

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(lambda: len(repo.vector_search(ws_id, pid, zero_vector, top_k=10)) > 0)

    ws_b = client.post("/workspaces", json={"name": "W-B"}, headers=BOB).json()
    assert repo.vector_search(ws_b["id"], pid, zero_vector, top_k=10) == []
