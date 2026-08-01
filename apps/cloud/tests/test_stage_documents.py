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


def test_hand_written_specify_creates_the_requirement_the_next_stage_gates_on():
    """A document typed into the Planner editor rather than generated used to
    leave the graph empty, so `plan` answered 409 requirement_required for a
    project whose specification was on screen."""
    client = _client()
    _ws_id, pid = _bootstrap(client)

    client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": "# QR checkout\n\nShoppers pay with a QR code."},
        headers=ALICE,
    )

    requirement = client.app.state.repository.get_latest_requirement(pid)
    assert requirement is not None
    assert requirement.title == "QR checkout"
    assert requirement.description == "Shoppers pay with a QR code."


def test_repeated_specify_saves_update_one_requirement_rather_than_appending():
    client = _client()
    _ws_id, pid = _bootstrap(client)
    repo = client.app.state.repository

    for title in ("# First", "# Second", "# Third"):
        client.patch(
            f"/projects/{pid}/stage-documents/specify", json={"content": title}, headers=ALICE
        )

    live = [r for r in repo._graph[pid]["requirements"].values() if r.deleted_at is None]
    assert len(live) == 1
    assert live[0].title == "Third"


def test_hand_written_plan_creates_a_spec_document_against_the_requirement():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    client.patch(
        f"/projects/{pid}/stage-documents/specify", json={"content": "# Spec"}, headers=ALICE
    )
    client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": "# Plan\n\nTypeScript on Node 24."},
        headers=ALICE,
    )

    repo = client.app.state.repository
    spec = repo.get_latest_spec_document(pid)
    assert spec is not None
    assert spec.content == "# Plan\n\nTypeScript on Node 24."
    assert spec.requirement_id == repo.get_latest_requirement(pid).id


def test_plan_saved_before_any_specify_projects_nothing():
    """A plan needs something to be a plan for; the endpoint leaves the graph
    alone rather than inventing a Requirement out of the plan's own text."""
    client = _client()
    _ws_id, pid = _bootstrap(client)

    res = client.patch(
        f"/projects/{pid}/stage-documents/plan", json={"content": "# Plan"}, headers=ALICE
    )

    assert res.status_code == 200, res.text
    assert client.app.state.repository.get_latest_spec_document(pid) is None


def test_empty_and_task_documents_project_nothing():
    client = _client()
    _ws_id, pid = _bootstrap(client)
    repo = client.app.state.repository

    client.patch(f"/projects/{pid}/stage-documents/specify", json={"content": "  "}, headers=ALICE)
    assert repo.get_latest_requirement(pid) is None

    # tasks stays generation-owned: re-parsing the checklist on every save
    # would fork the task list and orphan the status already on those rows.
    client.patch(
        f"/projects/{pid}/stage-documents/tasks",
        json={"content": "# Tasks\n\n- [ ] T001 Do the thing\n"},
        headers=ALICE,
    )
    assert not repo._graph[pid]["tasks"]


def test_a_failed_projection_does_not_fail_the_save(monkeypatch):
    client = _client()
    _ws_id, pid = _bootstrap(client)

    def _boom(*_args, **_kwargs):
        raise RuntimeError("graph unavailable")

    monkeypatch.setattr("app.api.stage_documents.project_stage_document", _boom)

    res = client.patch(
        f"/projects/{pid}/stage-documents/specify", json={"content": "# Spec"}, headers=ALICE
    )

    assert res.status_code == 200, res.text
    assert res.json()["content"] == "# Spec"


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
