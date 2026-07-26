"""GET/PATCH routes for the Planner raw-markdown side store
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _client() -> TestClient:
    app = create_app()
    c = TestClient(app)
    c.__enter__()
    c.app.state.embedding_provider = FakeEmbeddingProvider()
    c.app.state.chat_provider = FakeChatProvider()
    return c


def _bootstrap(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_get_returns_empty_content_when_no_document_exists():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    res = client.get(f"/projects/{pid}/stage-documents/plan", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json() == {"stage": "plan", "content": "", "updated_at": None}


def test_patch_then_get_roundtrips_content():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    patch_res = client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": "# Plan\n\nBuild it."},
        headers=ALICE,
    )
    assert patch_res.status_code == 200, patch_res.text
    assert patch_res.json()["content"] == "# Plan\n\nBuild it."

    get_res = client.get(f"/projects/{pid}/stage-documents/plan", headers=ALICE)
    assert get_res.json()["content"] == "# Plan\n\nBuild it."


def test_non_member_cannot_get_or_patch():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    get_res = client.get(f"/projects/{pid}/stage-documents/plan", headers=BOB)
    assert get_res.status_code == 403

    patch_res = client.patch(
        f"/projects/{pid}/stage-documents/plan", json={"content": "x"}, headers=BOB
    )
    assert patch_res.status_code == 403


def test_patch_enqueues_embed_job_for_rag(monkeypatch):
    client = _client()
    ws_id, pid = _bootstrap(client)

    # The real embed_worker_loop (started in app.main's lifespan) drains
    # app.state.embed_queue in-process and near-instantly, racing the test
    # thread's read of it right after the PATCH returns — deterministically
    # empty by the time we'd inspect it (EmbedQueue also wraps a private
    # asyncio.Queue as `_queue`, with no public sync-drain API to begin
    # with). Capture the job at the call site instead of racing the live
    # worker for it.
    captured: dict[str, object] = {}

    def _fake_enqueue(app, job):
        captured["job"] = job

    monkeypatch.setattr("app.api.stage_documents.enqueue", _fake_enqueue)

    client.patch(
        f"/projects/{pid}/stage-documents/plan", json={"content": "index me"}, headers=ALICE
    )

    job = captured["job"]
    assert job.workspace_id == ws_id
    assert job.project_id == pid
    assert job.node_type == "stage_documents"
