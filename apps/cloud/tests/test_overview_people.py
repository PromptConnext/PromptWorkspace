"""People links in the workspace overview (plan 0033)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import (
    Decision,
    GraphUpsertRequest,
    ProjectRole,
    Task,
    TaskStatus,
    TaskSummary,
    new_id,
    utcnow,
)
from app.overview.people import build_links

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _role(pid, hat, user):
    return ProjectRole(
        project_id=pid, workspace_id="w", hat=hat, user_id=user, assigned_by="alice"
    )


def _task(pid, user, i=0):
    return TaskSummary(
        task_id=f"t{pid}{user}{i}",
        project_id=pid,
        status=TaskStatus.verified,
        assigned_user_id=user,
        updated_at=utcnow(),
    )


def _decision(pid, req, res, status="approved"):
    return Decision(
        project_id=pid, workspace_id="w", kind="plan_approval", title="t",
        subject_stage="tasks", subject_hash="h", routed_hat="business_owner",
        requested_by=req, resolved_by=res, status=status,
    )


def test_hat_edge_per_role():
    links = build_links({"p1": [_role("p1", "business_owner", "bob")]}, [], {})
    (link,) = links
    assert (link.kind, link.from_user_id, link.to_user_id) == ("hat", "bob", None)
    assert (link.project_id, link.hat, link.weight) == ("p1", "business_owner", 1)


def test_work_edge_weight_is_task_count():
    tasks = [_task("p1", "bob", 0), _task("p1", "bob", 1), _task("p1", None), _task("p2", "bob")]
    links = build_links({}, tasks, {})
    assert [(k.kind, k.project_id, k.from_user_id, k.weight) for k in links] == [
        ("work", "p1", "bob", 2),
        ("work", "p2", "bob", 1),
    ]
    assert all(k.hat is None and k.to_user_id is None for k in links)


def test_approval_edge_requester_to_resolver_weighted():
    decisions = {
        "p1": [
            _decision("p1", "alice", "bob"),
            _decision("p1", "alice", "bob", "rejected"),
            _decision("p1", "alice", None, "open"),
            _decision("p1", "alice", "bob", "withdrawn"),
            _decision("p1", "bob", "bob"),
        ],
        "p2": [_decision("p2", "alice", "bob")],
    }
    (link,) = build_links({}, [], decisions)
    assert (link.kind, link.from_user_id, link.to_user_id) == ("approval", "alice", "bob")
    assert (link.project_id, link.hat, link.weight) == (None, None, 3)


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


def test_overview_endpoint_carries_people(client):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()["id"]
    inv = client.post(
        f"/workspaces/{ws}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    client.post(f"/invitations/{inv['invitation']['token']}/accept", headers=BOB)
    created = client.post("/projects", json={"name": "P", "workspace_id": ws}, headers=ALICE)
    pid = created.json()["id"]
    repo = client.app.state.repository
    repo.set_project_role(pid, ws, "business_owner", "bob", "alice")
    repo.upsert_graph(
        pid,
        GraphUpsertRequest(
            tasks=[Task(id=new_id(), project_id=pid, title="a", assigned_user_id="bob")]
        ),
        source="pz",
    )
    people = client.get(f"/workspaces/{ws}/overview", headers=BOB).json()["people"]
    assert [(p["kind"], p["from_user_id"], p["weight"]) for p in people] == [
        ("hat", "bob", 1),
        ("work", "bob", 1),
    ]
