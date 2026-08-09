"""GET /projects/{id}/assistant/index-status — the completion signal
POST .../reindex never had (ADR-adjacent: see docstring in
app/api/assistant.py). Enqueueing tells you nothing about whether jobs were
ever processed or silently dropped (app/rag/queue.py discards a job outright
when no model connection resolves), so this endpoint reports what's actually
on disk: chunk count, embed model, and how many nodes a full backfill would
sweep (app/rag/backfill.py::count_indexable_nodes — same enumeration
`enqueue_project_backfill` uses, not a second copy).

`pending_jobs`/`last_error` (this file's second half) close the remaining gap:
a chunk count that stays at zero looks identical whether the queue is still
draining or the jobs were thrown away for want of a model connection. Those
two fields come from EmbedQueue's own per-project bookkeeping, so the tests
below drive the queue directly rather than racing the background worker.

Membership-gated like chat (member, not admin-only like reindex itself) —
see test_other_workspace_member_cannot_reach_project below.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Document
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider
from app.rag.queue import EmbedJob

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


def test_status_reports_no_pending_jobs_and_no_error_on_a_quiet_project():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()

    body = client.get(f"/projects/{project['id']}/assistant/index-status", headers=ALICE).json()
    assert body["pending_jobs"] == 0
    assert body["last_error"] is None

    client.__exit__(None, None, None)


def test_pending_jobs_counts_only_this_project_and_drops_to_zero_on_completion():
    """Swapping in a fresh queue after startup is deliberate: `embed_worker_loop`
    binds `app.state.embed_queue` once, before its while loop, so the running
    worker keeps draining the original and this one stays untouched — which is
    the only way to observe a non-zero in-flight count without racing it."""
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    mine = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]
    other = client.post(
        "/projects", json={"name": "Q", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]

    from app.rag.queue import EmbedQueue

    queue = EmbedQueue()
    client.app.state.embed_queue = queue
    jobs = [
        EmbedJob(workspace_id=ws["id"], project_id=mine, node_type="requirements", node_id="r1"),
        EmbedJob(workspace_id=ws["id"], project_id=mine, node_type="requirements", node_id="r2"),
        EmbedJob(workspace_id=ws["id"], project_id=other, node_type="requirements", node_id="r3"),
    ]
    for job in jobs:
        queue.put_nowait(job)

    body = client.get(f"/projects/{mine}/assistant/index-status", headers=ALICE).json()
    assert body["pending_jobs"] == 2, "the third job belongs to another project"

    for job in jobs:
        queue.complete(job)

    body = client.get(f"/projects/{mine}/assistant/index-status", headers=ALICE).json()
    assert body["pending_jobs"] == 0

    client.__exit__(None, None, None)


def test_a_reindex_with_no_model_connection_reports_the_drop_as_last_error():
    """The exact screen this field exists for: 59 items queued, 0 chunks
    indexed, forever — because `_process_job` discards rather than defers when
    no model connection resolves. Without `last_error` that state is
    indistinguishable from a slow queue."""
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

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

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["enqueued"] >= 1

    # No sleep: each request hands control back to the event loop the worker
    # runs on, so polling the endpoint is itself what lets the queue drain.
    for _ in range(50):
        body = client.get(f"/projects/{pid}/assistant/index-status", headers=ALICE).json()
        if body["last_error"] is not None:
            break
    assert body["last_error"] is not None, "the discarded job left no trace"
    assert body["last_error"]["code"] == "no_model_connection"
    assert body["last_error"]["node_id"] == "r1"
    assert body["indexed_chunks"] == 0

    client.__exit__(None, None, None)


def test_a_successful_job_retires_an_earlier_error():
    """A fixed misconfiguration must stop accusing itself once chunks land,
    otherwise the panel shows a permanent red line after a successful reindex."""
    from app.rag.queue import EmbedQueue

    queue = EmbedQueue()
    job = EmbedJob(workspace_id="w1", project_id="p1", node_type="requirements", node_id="r1")
    queue.record_failure(job, "no_model_connection", "nothing configured")
    assert queue.last_failure_for("p1") is not None

    queue.clear_failure("p1")
    assert queue.last_failure_for("p1") is None


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
