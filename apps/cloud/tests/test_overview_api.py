"""GET /workspaces/{id}/overview (plan 0033)."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Decision, GraphUpsertRequest, Task, TaskStatus, new_id, utcnow

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
MALLORY = {"X-User-Id": "mallory"}


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def workspace(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200, accept.text
    return ws["id"]


def _overview(client: TestClient, ws: str):
    return client.get(f"/workspaces/{ws}/overview", headers=BOB)


def _new_project(client: TestClient, ws: str, name: str = "P") -> str:
    res = client.post("/projects", json={"name": name, "workspace_id": ws}, headers=ALICE)
    return res.json()["id"]


def test_overview_requires_membership(client, workspace):
    res = client.get(f"/workspaces/{workspace}/overview", headers=MALLORY)
    assert res.status_code == 403


def test_overview_empty_project_has_nulls_and_zero_counts(client, workspace):
    _new_project(client, workspace)
    body = _overview(client, workspace).json()
    assert body["truncated"] is False
    assert body["people"] == []
    assert {m["user_id"] for m in body["members"]} == {"alice", "bob"}
    (card,) = body["projects"]
    assert card["stack"] is None
    assert card["hats"] == {"business_owner": None, "tech_steward": None}
    assert all(v == 0 for v in card["task_counts"].values())
    failing = {c["id"] for c in card["checks"] if not c["ok"]}
    assert {"hat_business_owner", "hat_tech_steward"} <= failing


def test_overview_card_reflects_roles_tasks_decisions(client, workspace):
    pid = _new_project(client, workspace)
    repo = client.app.state.repository
    repo.set_project_role(pid, workspace, "business_owner", "bob", "alice")
    repo.save_decision(
        Decision(
            project_id=pid, workspace_id=workspace, kind="plan_approval", title="Approve",
            subject_stage="tasks", subject_hash="h", routed_hat="business_owner",
            requested_by="alice",
        )
    )
    repo.upsert_graph(
        pid,
        GraphUpsertRequest(
            tasks=[
                Task(id=new_id(), project_id=pid, title="a", assigned_user_id="bob"),
                Task(id=new_id(), project_id=pid, title="b", status=TaskStatus.verified),
            ]
        ),
        source="pz",
    )
    (card,) = _overview(client, workspace).json()["projects"]
    assert card["hats"]["business_owner"] == "bob"
    assert card["hats"]["tech_steward"] is None
    assert sum(card["task_counts"].values()) == 2
    assert card["task_counts"]["verified"] == 1
    assert card["contributors"] == ["bob"]
    assert card["decisions"]["open"] == 1
    ok = {c["id"]: c["ok"] for c in card["checks"]}
    assert ok["hat_business_owner"] is True
    assert ok["hat_tech_steward"] is False


def test_overview_truncates_after_200(client, workspace):
    repo = client.app.state.repository
    base = utcnow()
    for i in range(201):
        p = repo.create_project(workspace, "alice", f"p{i}")
        # relies on the memory adapter returning its stored instances
        p.updated_at = base + timedelta(seconds=i)
    body = _overview(client, workspace).json()
    assert len(body["projects"]) == 200
    assert body["truncated"] is True
    names = [c["name"] for c in body["projects"]]
    assert names[0] == "p200"
    assert "p0" not in names
    stamps = [c["updated_at"] for c in body["projects"]]
    assert stamps == sorted(stamps, reverse=True)


def test_overview_with_no_projects(client, workspace):
    res = _overview(client, workspace)
    assert res.status_code == 200
    body = res.json()
    assert body["projects"] == []
    assert body["truncated"] is False
    assert {m["user_id"] for m in body["members"]} == {"alice", "bob"}


def test_overview_uses_default_governance_without_row(client, workspace):
    _new_project(client, workspace)
    repo = client.app.state.repository
    assert repo.get_workspace_governance(workspace) is None
    (card,) = _overview(client, workspace).json()["projects"]
    ok = {c["id"]: c["ok"] for c in card["checks"]}
    assert ok["hat_business_owner"] is False
    assert ok["hat_tech_steward"] is False
    assert repo.get_workspace_governance(workspace) is None


def test_overview_reads_each_family_once(client, workspace):
    for i in range(3):
        _new_project(client, workspace, f"P{i}")
    repo = client.app.state.repository
    with (
        patch.object(repo, "list_project_roles_for", wraps=repo.list_project_roles_for) as roles,
        patch.object(repo, "list_decisions_for", wraps=repo.list_decisions_for) as decisions,
        patch.object(repo, "get_repo_analyses", wraps=repo.get_repo_analyses) as analyses,
        patch.object(repo, "list_project_roles", wraps=repo.list_project_roles) as one_roles,
        patch.object(repo, "list_decisions", wraps=repo.list_decisions) as one_decisions,
        patch.object(repo, "get_repo_analysis", wraps=repo.get_repo_analysis) as one_analysis,
    ):
        res = _overview(client, workspace)
    assert res.status_code == 200
    assert len(res.json()["projects"]) == 3
    for batched in (roles, decisions, analyses):
        assert batched.call_count == 1
    for single in (one_roles, one_decisions, one_analysis):
        assert single.call_count == 0
