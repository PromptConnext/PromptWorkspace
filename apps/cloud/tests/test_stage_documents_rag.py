"""stage_documents participates in RAG indexing like every other node type
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from app.models.schemas import StageDocument
from app.rag.source import RAG_NODE_TYPES, node_text


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
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.rag.chat import FakeChatProvider
    from app.rag.embedder import FakeEmbeddingProvider

    ALICE = {"X-User-Id": "alice"}
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
