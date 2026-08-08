"""POST /workspaces/{id}/model-connection fans out a backfill across every
project in the workspace after storing the connection (app/rag/backfill.py).

Before this, content synced while no model connection existed (or while an
earlier one was misconfigured) was permanently lost: app/rag/queue.py's
`_process_job` resolves a connection per job and, finding none, logs at
debug and returns — the job is discarded, not deferred. Connecting a model
later backfilled nothing on its own; the only recovery was the per-project,
admin-only `POST /projects/{id}/assistant/reindex`, which meant visiting
every project's settings page by hand to recover a whole workspace.

Same monkeypatch-the-enqueue-call-site pattern as
tests/test_stage_documents_rag.py: the real embed_worker_loop drains
app.state.embed_queue in-process and near-instantly, racing a synchronous
read of the queue, and EmbedQueue exposes no public sync-drain API. Capturing
at the `app.rag.backfill.enqueue` call site (that's where the actual
enqueue() calls now live, post-refactor) sidesteps the race entirely.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}

CONNECTION_BODY = {
    "provider": "openai",
    "base_url": "https://api.example.com/v1",
    "model": "gpt-x",
    "embed_model": "embed-x",
    "api_key": "sk-test",
}


def _make_client() -> TestClient:
    app = create_app()
    client = TestClient(app)
    client.__enter__()
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    client.app.state.chat_provider = FakeChatProvider()
    return client


def _seed_requirement(client: TestClient, project_id: str, req_id: str) -> None:
    """Land a graph entity with no model connection configured yet — the
    live scenario this task was written from: the sync push's own enqueue
    call (app/api/sync.py) fires and is immediately dropped by
    app/rag/queue.py since no connection resolves, but the row itself lands
    fine (sync must keep working without RAG). It's this row the backfill
    sweep has to pick back up from app.rag.backfill's `get_graph` bootstrap
    pull, independent of whatever happened to the original job.
    """
    res = client.put(
        f"/sync/projects/{project_id}/graph",
        json={
            "requirements": [
                {
                    "id": req_id,
                    "project_id": project_id,
                    "title": "Payments",
                    "description": "x " * 20,
                }
            ]
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text


def test_connecting_a_model_enqueues_jobs_for_preexisting_content(monkeypatch):
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    # Content synced before any model connection existed — per the queue's
    # "no model connection" branch, its embed job was already dropped.
    _seed_requirement(client, pid, "r1")

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(
        f"/workspaces/{ws['id']}/model-connection", json=CONNECTION_BODY, headers=ALICE
    )
    assert res.status_code == 200, res.text

    requirement_jobs = [
        j for j in captured if j.node_type == "requirements" and j.project_id == pid
    ]
    assert [j.node_id for j in requirement_jobs] == ["r1"]

    client.__exit__(None, None, None)


def test_backfill_fans_out_across_multiple_projects_in_the_workspace(monkeypatch):
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project_a = client.post(
        "/projects", json={"name": "A", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    project_b = client.post(
        "/projects", json={"name": "B", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid_a, pid_b = project_a["id"], project_b["id"]

    _seed_requirement(client, pid_a, "r-a")
    _seed_requirement(client, pid_b, "r-b")

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(
        f"/workspaces/{ws['id']}/model-connection", json=CONNECTION_BODY, headers=ALICE
    )
    assert res.status_code == 200, res.text

    project_ids_seen = {j.project_id for j in captured if j.node_type == "requirements"}
    assert project_ids_seen == {pid_a, pid_b}

    client.__exit__(None, None, None)


def test_backfill_does_not_reach_projects_in_a_different_workspace(monkeypatch):
    client = _make_client()
    ws_target = client.post("/workspaces", json={"name": "Target"}, headers=ALICE).json()
    project_target = client.post(
        "/projects", json={"name": "P", "workspace_id": ws_target["id"]}, headers=ALICE
    ).json()
    pid_target = project_target["id"]

    ws_other = client.post("/workspaces", json={"name": "Other"}, headers=ALICE).json()
    project_other = client.post(
        "/projects", json={"name": "P", "workspace_id": ws_other["id"]}, headers=ALICE
    ).json()
    pid_other = project_other["id"]

    _seed_requirement(client, pid_target, "r-target")
    _seed_requirement(client, pid_other, "r-other")

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(
        f"/workspaces/{ws_target['id']}/model-connection", json=CONNECTION_BODY, headers=ALICE
    )
    assert res.status_code == 200, res.text

    project_ids_seen = {j.project_id for j in captured}
    assert pid_other not in project_ids_seen
    assert pid_target in project_ids_seen

    client.__exit__(None, None, None)
