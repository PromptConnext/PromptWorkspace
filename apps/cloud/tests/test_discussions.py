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


def _join(client, workspace_id: str, user: str) -> None:
    """BOB is a deliberate non-member in this module's fixture; the graph-write
    cases below are about a *member's* powers, so they invite him in first."""
    invitation = client.post(
        f"/workspaces/{workspace_id}/invitations",
        json={"email": f"{user}@x.com"},
        headers=ALICE,
    ).json()
    accept = client.post(
        f"/invitations/{invitation['invitation']['token']}/accept",
        headers={"X-User-Id": user},
    )
    assert accept.status_code == 200, accept.text


def _push_discussion(client, pid, task_id, headers, **fields):
    discussion = {
        "id": "d1",
        "project_id": pid,
        "parent_node_type": "tasks",
        "parent_node_id": task_id,
        "author": "alice",
        "body": "Original",
        "source": "pz",
    }
    discussion.update(fields)
    return client.put(
        f"/sync/projects/{pid}/graph", json={"discussions": [discussion]}, headers=headers
    )


def test_a_member_cannot_post_as_somebody_else_through_a_graph_push(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    """`create_discussion` takes `author` from the authenticated caller and never
    from the body — a comment is an attributed statement. The graph door took
    both `author` and the entity-level `source` from the body (plan 0015, review
    round 2)."""
    ws_id, pid, task_id = project_with_task
    _join(client, ws_id, "bob")

    spoofed = _push_discussion(client, pid, task_id, BOB, author="alice", body="Ship it")
    assert spoofed.status_code == 403, spoofed.text
    assert spoofed.json()["detail"] == "discussion_author_forbidden"

    mirrored = _push_discussion(client, pid, task_id, BOB, author="bob", source="pmo")
    assert mirrored.status_code == 403, mirrored.text
    assert mirrored.json()["detail"] == "discussion_author_forbidden"

    assert client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()["discussions"] == []


def test_a_member_cannot_rewrite_another_authors_comment(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    """`body` and `author` are "shared" authority, so neither the ownership gate
    nor LWW stands between a member and somebody else's stored comment."""
    ws_id, pid, task_id = project_with_task
    _join(client, ws_id, "bob")
    assert _push_discussion(client, pid, task_id, ALICE).status_code == 200

    tamper = _push_discussion(client, pid, task_id, BOB, author="bob", body="TAMPERED")
    assert tamper.status_code == 403, tamper.text
    assert tamper.json()["detail"] == "discussion_forbidden"

    stored = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()["discussions"][0]
    assert stored["body"] == "Original"
    assert stored["author"] == "alice"


def test_a_member_may_still_push_their_own_comment(
    client: TestClient, project_with_task: tuple[str, str, str]
):
    ws_id, pid, task_id = project_with_task
    _join(client, ws_id, "bob")
    res = _push_discussion(client, pid, task_id, BOB, author="bob", body="Mine")
    assert res.status_code == 200, res.text

    edit = _push_discussion(client, pid, task_id, BOB, author="bob", body="Mine, edited")
    assert edit.status_code == 200, edit.text
    stored = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()["discussions"][0]
    assert stored["body"] == "Mine, edited"


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
