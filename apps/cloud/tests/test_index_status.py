"""GET /projects/{id}/assistant/index-status — the completion signal
POST .../reindex never had (ADR-adjacent: see docstring in
app/api/assistant.py). Enqueueing tells you nothing about whether jobs were
ever processed or silently dropped (app/rag/queue.py discards a job outright
when no model connection resolves), so this endpoint reports what's actually
on disk: chunk count, embed model, and how many nodes a full backfill would
sweep (app/rag/backfill.py::count_indexable_nodes — same enumeration
`enqueue_project_backfill` uses, not a second copy).

Membership-gated like chat (member, not admin-only like reindex itself) —
see test_other_workspace_member_cannot_reach_project below.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Document
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _make_client() -> TestClient:
    app = create_app()
    client = TestClient(app)
    client.__enter__()
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    client.app.state.chat_provider = FakeChatProvider()
    return client


def test_status_reports_zero_for_a_project_with_no_chunks():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    res = client.get(f"/projects/{pid}/assistant/index-status", headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["indexed_chunks"] == 0
    assert body["indexable_nodes"] == 0
    assert body["embed_model"] is None

    client.__exit__(None, None, None)


def test_status_reports_the_real_count_and_embed_model_after_chunks_exist():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    ws_id = ws["id"]
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws_id}, headers=ALICE
    ).json()
    pid = project["id"]

    # Land chunks directly through the repository — same shape
    # test_assistant_keyless.py::test_embed_model_mismatch_requires_reindex
    # uses to seed a chunk without going through the queue/worker race.
    repo = client.app.state.repository
    repo.upsert_rag_chunks(
        ws_id, pid, "documents", "doc-1", ["chunk one", "chunk two"], [[0.0] * 8, [0.0] * 8],
        "embed-x",
    )

    res = client.get(f"/projects/{pid}/assistant/index-status", headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["indexed_chunks"] == 2
    assert body["embed_model"] == "embed-x"

    client.__exit__(None, None, None)


def test_indexable_nodes_counts_all_three_backfill_categories():
    """Mirrors test_stage_documents_rag.py::test_reindex_sweeps_all_three_categories
    — indexable_nodes must come from the same enumeration the reindex sweep
    uses (app/rag/backfill.py), not a second, driftable copy."""
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    # Graph entity, via sync push.
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

    # Stage document — "constitution" has no graph-entity projection, so it
    # doesn't muddy the count with a second requirement.
    res = client.patch(
        f"/projects/{pid}/stage-documents/constitution",
        json={"content": "# Constitution"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

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

    res = client.get(f"/projects/{pid}/assistant/index-status", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["indexable_nodes"] == 3

    client.__exit__(None, None, None)


def test_non_member_gets_403():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    # bob is a member of a different workspace entirely.
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)

    res = client.get(f"/projects/{pid}/assistant/index-status", headers=BOB)
    assert res.status_code == 403

    client.__exit__(None, None, None)
