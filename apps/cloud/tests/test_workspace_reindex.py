"""POST /workspaces/{id}/assistant/reindex — the deliberate "reindex
everything" control for the cases the automatic backfill
(POST /workspaces/{id}/model-connection, see test_model_connection_backfill.py)
doesn't cover: a model swapped in place, an embedding dimension change, a
failed batch, or plain doubt about index freshness. Same admin gate and
enqueue-only contract as the per-project `POST /projects/{id}/assistant/reindex`
(test_stage_documents_rag.py), fanned out via the same
app/rag/backfill.py::enqueue_workspace_backfill the model-connection path
already uses.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Role
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


def _seed_requirement(client: TestClient, project_id: str, req_id: str) -> None:
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


def test_enqueues_across_every_project_in_the_workspace(monkeypatch):
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    ws_id = ws["id"]
    project_a = client.post(
        "/projects", json={"name": "A", "workspace_id": ws_id}, headers=ALICE
    ).json()
    project_b = client.post(
        "/projects", json={"name": "B", "workspace_id": ws_id}, headers=ALICE
    ).json()
    pid_a, pid_b = project_a["id"], project_b["id"]

    _seed_requirement(client, pid_a, "r-a")
    _seed_requirement(client, pid_b, "r-b")

    captured: list[object] = []
    monkeypatch.setattr("app.rag.backfill.enqueue", lambda app, job: captured.append(job))

    res = client.post(f"/workspaces/{ws_id}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["enqueued"] == 2
    assert body["projects_swept"] == 2
    project_ids_reported = {p["project_id"] for p in body["projects"]}
    assert project_ids_reported == {pid_a, pid_b}
    for p in body["projects"]:
        assert p["enqueued"] == 1

    project_ids_seen = {j.project_id for j in captured if j.node_type == "requirements"}
    assert project_ids_seen == {pid_a, pid_b}

    client.__exit__(None, None, None)


def test_does_not_touch_projects_in_another_workspace(monkeypatch):
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

    res = client.post(f"/workspaces/{ws_target['id']}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["projects_swept"] == 1
    project_ids_reported = {p["project_id"] for p in body["projects"]}
    assert pid_other not in project_ids_reported
    assert pid_target in project_ids_reported

    project_ids_seen = {j.project_id for j in captured}
    assert pid_other not in project_ids_seen
    assert pid_target in project_ids_seen

    client.__exit__(None, None, None)


def test_non_admin_member_gets_403():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    ws_id = ws["id"]

    repo = client.app.state.repository
    repo.add_member(ws_id, "bob", Role.member, invited_by="alice")

    res = client.post(f"/workspaces/{ws_id}/assistant/reindex", headers=BOB)
    assert res.status_code == 403

    client.__exit__(None, None, None)


def test_non_member_gets_403_or_404():
    client = _make_client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    ws_id = ws["id"]

    # bob never joined this workspace at all.
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)

    res = client.post(f"/workspaces/{ws_id}/assistant/reindex", headers=BOB)
    assert res.status_code in (403, 404)

    client.__exit__(None, None, None)
