"""Discussion entity (M12): CRUD via both the sync-push path and the new
POST /projects/{id}/discussions endpoint, tombstone GC, and the
FIELD_AUTHORITY["discussions"] = "shared" behavior (both pz and pmo sources
can create their own rows without the merge dropping either)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


@pytest.fixture
def project_with_task(client: TestClient) -> tuple[str, str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    push = client.put(
        f"/sync/projects/{project['id']}/graph",
        json={
            "requirements": [{"id": "r1", "project_id": project["id"], "title": "Req"}],
            "spec_documents": [
                {"id": "s1", "project_id": project["id"], "requirement_id": "r1", "content": "spec"}
            ],
            "tasks": [
                {"id": "t1", "project_id": project["id"], "spec_id": "s1", "title": "Task 1"}
            ],
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text
    return ws["id"], project["id"], "t1"


def test_create_discussion_via_api_sets_author_from_caller(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    _ws_id, pid, task_id = project_with_task
    res = client.post(
        f"/projects/{pid}/discussions",
        json={"parent_node_type": "tasks", "parent_node_id": task_id, "body": "Looks good"},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["author"] == "alice"
    assert body["source"] == "pz"
    assert body["body"] == "Looks good"

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert len(graph["discussions"]) == 1
    assert graph["discussions"][0]["parent_node_id"] == task_id


def test_create_discussion_rejects_unknown_parent_node(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    _ws_id, pid, _task_id = project_with_task
    res = client.post(
        f"/projects/{pid}/discussions",
        json={"parent_node_type": "tasks", "parent_node_id": "no-such-task", "body": "hi"},
        headers=ALICE,
    )
    assert res.status_code == 404


def test_create_discussion_rejects_invalid_parent_type(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    _ws_id, pid, task_id = project_with_task
    res = client.post(
        f"/projects/{pid}/discussions",
        json={"parent_node_type": "discussions", "parent_node_id": task_id, "body": "hi"},
        headers=ALICE,
    )
    assert res.status_code == 422


def test_non_member_cannot_create_discussion(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    _ws_id, pid, task_id = project_with_task
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)
    res = client.post(
        f"/projects/{pid}/discussions",
        json={"parent_node_type": "tasks", "parent_node_id": task_id, "body": "hi"},
        headers=BOB,
    )
    assert res.status_code == 403


def test_discussion_via_sync_push_appears_in_graph(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    """Desktop's push path (not just the web-authoring endpoint) can also
    create discussions — same GraphUpsertRequest.discussions field."""
    _ws_id, pid, task_id = project_with_task
    push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d1",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "alice",
                    "body": "From desktop",
                    "source": "pz",
                }
            ]
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text
    assert push.json()["upserted"]["discussions"] == 1

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert graph["discussions"][0]["body"] == "From desktop"


def test_pz_and_pmo_can_each_create_their_own_discussion_row(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    """FIELD_AUTHORITY["discussions"]["body"] = "shared" — unlike Task.status,
    a pmo-source upsert must not be silently dropped."""
    _ws_id, pid, task_id = project_with_task
    pz_push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d-pz",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "alice",
                    "body": "Native comment",
                    "source": "pz",
                }
            ],
            "source": "pz",
        },
        headers=ALICE,
    )
    assert pz_push.status_code == 200

    pmo_push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d-pmo",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "jira-bot",
                    "body": "Mirrored comment",
                    "source": "pmo",
                }
            ],
            "source": "pmo",
        },
        headers=ALICE,
    )
    assert pmo_push.status_code == 200

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    bodies = {d["id"]: d["body"] for d in graph["discussions"]}
    assert bodies == {"d-pz": "Native comment", "d-pmo": "Mirrored comment"}


def test_tombstoned_discussion_is_hidden_on_bootstrap_pull(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    _ws_id, pid, task_id = project_with_task
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d1",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "alice",
                    "body": "to delete",
                }
            ]
        },
        headers=ALICE,
    )
    from datetime import datetime, timezone

    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "discussions": [
                {
                    "id": "d1",
                    "project_id": pid,
                    "parent_node_type": "tasks",
                    "parent_node_id": task_id,
                    "author": "alice",
                    "body": "to delete",
                    "deleted_at": datetime.now(timezone.utc).isoformat(),
                }
            ]
        },
        headers=ALICE,
    )

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert graph["discussions"] == []
