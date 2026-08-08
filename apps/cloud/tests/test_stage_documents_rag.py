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
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

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


def test_reindex_sweeps_uploaded_documents(monkeypatch):
    """The PRD must be recoverable by reindexing.

    Reindex used to skip `documents` entirely, on the reasoning that
    documents.py enqueues on upload so no backfill scenario existed. That only
    holds if a model connection resolved at upload time; when none did, the job
    was dropped by app/rag/queue.py and the PRD stayed permanently unindexed —
    while the reindex button reported a healthy count that silently excluded
    the one artifact users most expect the assistant to have read.
    """
    from app.main import create_app
    from app.models.schemas import Document
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

    repo = client.app.state.repository
    doc = Document(
        workspace_id=ws["id"],
        project_id=pid,
        title="MakeStoryTime-PRD.pdf",
        mime="application/pdf",
        source_kind="upload",
        storage_ref="test/MakeStoryTime-PRD.pdf",
        extracted_text="The product lets families write bedtime stories together.",
        status="extracted",
        created_by="alice",
    )
    repo.create_document(doc)

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200

    document_jobs = [j for j in captured if j.node_type == "documents"]
    assert [j.node_id for j in document_jobs] == [doc.id]
    assert res.json()["enqueued"] >= 1

    client.__exit__(None, None, None)


def test_reindex_sweeps_all_three_categories(monkeypatch):
    """Guards the app/rag/backfill.py extraction itself: reindex_project used
    to inline all three sweeps (graph entities, stage documents, uploaded
    documents) directly; now it delegates to enqueue_project_backfill. This
    seeds one of each and checks a single reindex call still covers all
    three — the exact drift the extraction exists to prevent."""
    from app.main import create_app
    from app.models.schemas import Document
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

    # Graph entity, via sync push (no model connection needed to land it).
    res = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {"id": "r1", "project_id": pid, "title": "Payments", "description": "x " * 20}
            ]
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    # Stage document. Uses "constitution" specifically because it has no
    # graph-entity projection (app/generation/projection.py) — "plan" would
    # also enqueue a spec_documents projection job once a requirement
    # exists, muddying this test's node-type assertion below.
    res = client.patch(
        f"/projects/{pid}/stage-documents/constitution",
        json={"content": "# Constitution"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    stage_doc = client.app.state.repository.get_stage_document(pid, "constitution")
    assert stage_doc is not None

    # Uploaded document.
    repo = client.app.state.repository
    doc = Document(
        workspace_id=ws["id"],
        project_id=pid,
        title="PRD.pdf",
        mime="application/pdf",
        source_kind="upload",
        storage_ref="test/PRD.pdf",
        extracted_text="The product does the thing.",
        status="extracted",
        created_by="alice",
    )
    repo.create_document(doc)

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text

    node_types = {j.node_type for j in captured}
    assert node_types == {"requirements", "stage_documents", "documents"}
    assert res.json()["enqueued"] == 3

    client.__exit__(None, None, None)


def test_specify_patch_enqueues_projection_job_for_requirement(monkeypatch):
    """app/generation/projection.py::project_stage_document upserts the
    Requirement directly through the repository, bypassing the enqueue loop
    that lives in app/api/sync.py's push handler — so the projected entity
    was never getting embedded until the caller enqueued it itself."""
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

    captured: list[object] = []
    monkeypatch.setattr("app.api.stage_documents.enqueue", lambda app, job: captured.append(job))

    res = client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": "# Spec\n\nDo the thing."},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    requirement = client.app.state.repository.get_latest_requirement(pid)
    assert requirement is not None

    projection_jobs = [j for j in captured if j.node_type == "requirements"]
    assert [j.node_id for j in projection_jobs] == [requirement.id]

    client.__exit__(None, None, None)


def test_plan_patch_enqueues_projection_job_for_spec_document(monkeypatch):
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

    # A plan projects onto a SpecDocument tied to the latest Requirement, so
    # specify must land first (same precondition test_plan_saved_before_any_
    # specify_projects_nothing exercises in test_stage_documents.py).
    client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": "# Spec"},
        headers=ALICE,
    )

    captured: list[object] = []
    monkeypatch.setattr("app.api.stage_documents.enqueue", lambda app, job: captured.append(job))

    res = client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": "# Plan\n\nBuild it."},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    spec_document = client.app.state.repository.get_latest_spec_document(pid)
    assert spec_document is not None

    projection_jobs = [j for j in captured if j.node_type == "spec_documents"]
    assert [j.node_id for j in projection_jobs] == [spec_document.id]

    client.__exit__(None, None, None)


def test_constitution_patch_enqueues_no_projection_job(monkeypatch):
    """constitution has no graph entity (app/generation/projection.py's
    module docstring), so nothing beyond the stage_documents job itself
    should be enqueued."""
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

    captured: list[object] = []
    monkeypatch.setattr("app.api.stage_documents.enqueue", lambda app, job: captured.append(job))

    res = client.patch(
        f"/projects/{pid}/stage-documents/constitution",
        json={"content": "# Constitution"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    assert [j.node_type for j in captured] == ["stage_documents"]

    client.__exit__(None, None, None)


def test_empty_specify_patch_enqueues_no_projection_job(monkeypatch):
    """An empty document projects nothing (project_stage_document returns
    None), so there is no entity id to enqueue a job for."""
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

    captured: list[object] = []
    monkeypatch.setattr("app.api.stage_documents.enqueue", lambda app, job: captured.append(job))

    res = client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": "   "},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    assert [j.node_type for j in captured] == ["stage_documents"]
    assert client.app.state.repository.get_latest_requirement(pid) is None

    client.__exit__(None, None, None)
