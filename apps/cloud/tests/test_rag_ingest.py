"""Embed-on-ingest pipeline (M9): sync upsert -> queue -> chunks; tombstone
deletes its chunks. Uses FakeEmbeddingProvider so this exercises no network."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        # Swap in network-free providers before any request is made.
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


def _bootstrap(client: TestClient) -> tuple[str, str]:
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
    return ws["id"], project["id"]


def _chunk_count(client: TestClient, ws_id: str, pid: str) -> int:
    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    return len(repo.vector_search(ws_id, pid, zero_vector, top_k=100))


def test_sync_push_enqueues_embedding(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "Payments",
                    "description": "Support one-time and subscription payments.",
                }
            ]
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    assert _wait_until(lambda: _chunk_count(client, ws_id, pid) > 0)


def test_tombstone_deletes_its_chunks(client: TestClient):
    ws_id, pid = _bootstrap(client)

    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {"id": "r1", "project_id": pid, "title": "Payments", "description": "x " * 20}
            ]
        },
        headers=ALICE,
    )
    assert _wait_until(lambda: _chunk_count(client, ws_id, pid) > 0)

    # A delete is an upsert that sets deleted_at (M1 tombstone convention).
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "Payments",
                    "description": "x " * 20,
                    "deleted_at": "2026-01-01T00:00:00Z",
                }
            ]
        },
        headers=ALICE,
    )
    assert _wait_until(lambda: _chunk_count(client, ws_id, pid) == 0)


def test_embedding_skipped_when_no_model_connection(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    res = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {"id": "r1", "project_id": pid, "title": "T", "description": "d"}
            ]
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    # Give the worker a beat; it must skip (no model connection) rather than
    # crash the app or block the push, which already returned 200 above.
    time.sleep(0.1)
    assert _chunk_count(client, ws["id"], pid) == 0
