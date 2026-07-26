"""stage_documents participates in RAG indexing like every other node type
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.models.schemas import StageDocument
from app.rag.source import RAG_NODE_TYPES, node_text

ALICE = {"X-User-Id": "alice"}


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_stage_documents_is_a_rag_node_type():
    assert "stage_documents" in RAG_NODE_TYPES


def test_node_text_returns_stripped_content():
    doc = StageDocument(
        workspace_id="ws-1",
        project_id="proj-1",
        stage="plan",
        content="  # Plan\n\nBuild it.  \n",
        created_by="user-1",
    )
    assert node_text("stage_documents", doc) == "# Plan\n\nBuild it."


def test_reindex_sweeps_stage_documents(monkeypatch):
    from app.main import create_app
    from app.rag.chat import FakeChatProvider
    from app.rag.embedder import FakeEmbeddingProvider

    app = create_app()
    client = TestClient(app)
    client.__enter__()
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    client.app.state.chat_provider = FakeChatProvider()

    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    # The real embed_worker_loop drains app.state.embed_queue in-process and
    # near-instantly, racing this test's read of it, and EmbedQueue exposes
    # no public sync-drain API to begin with (same issue Task 3's
    # test_patch_enqueues_embed_job_for_rag hit). Capture jobs at each call
    # site via monkeypatch instead of racing the live worker for the queue.
    monkeypatch.setattr("app.api.stage_documents.enqueue", lambda app, job: None)

    client.patch(f"/projects/{pid}/stage-documents/plan", json={"content": "x"}, headers=ALICE)

    captured: list[object] = []
    monkeypatch.setattr("app.api.assistant.enqueue", lambda app, job: captured.append(job))

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["enqueued"] >= 1
    assert any(getattr(job, "node_type", None) == "stage_documents" for job in captured)


def test_patch_stage_document_produces_rag_chunks_end_to_end():
    """The regression this whole module exists to catch: an EmbedJob being
    *queued* (test_reindex_sweeps_stage_documents, test_patch_enqueues_embed_job_for_rag
    in test_stage_documents.py) does not prove it was ever *processed*. This
    lets the real (non-monkeypatched) embed_worker_loop run end-to-end —
    repo.get_node("stage_documents", ...) must resolve the node and
    node.deleted_at must not blow up — and asserts a chunk actually lands in
    vector_search-reachable storage, same shape as
    test_documents.py::test_markdown_upload_produces_rag_chunks."""
    from app.main import create_app
    from app.rag.chat import FakeChatProvider
    from app.rag.embedder import FakeEmbeddingProvider

    app = create_app()
    client = TestClient(app)
    client.__enter__()
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    client.app.state.chat_provider = FakeChatProvider()

    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    ws_id = ws["id"]
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws_id}, headers=ALICE
    ).json()
    pid = project["id"]
    conn = client.post(
        f"/workspaces/{ws_id}/model-connection",
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

    def _chunk_count() -> int:
        repo = client.app.state.repository
        zero_vector = [0.0] * FakeEmbeddingProvider.dim
        return len(repo.vector_search(ws_id, pid, zero_vector, top_k=100))

    assert _chunk_count() == 0

    res = client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": "# Plan\n\nBuild the payments rollout."},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    assert _wait_until(lambda: _chunk_count() > 0), "chunks never appeared"
