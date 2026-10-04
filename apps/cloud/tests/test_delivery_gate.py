"""GET /me/decisions and the plan-approval gate on create-repository."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import GraphUpsertRequest, Requirement, SpecDocument

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

TASKS = """# Tasks

Enough prose here for the document parser's minimum-length check to accept this as a
real generated document rather than a token stub.

## Phase 1: Setup
- [ ] T001 Create the project
"""


def _project(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    pid = client.post("/projects", json={"name": "Rocket Ship", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    repo = client.app.state.repository
    requirement = Requirement(project_id=pid, title="R")
    repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")
    spec = SpecDocument(project_id=pid, requirement_id=requirement.id, content="# Spec")
    repo.upsert_graph(pid, GraphUpsertRequest(spec_documents=[spec]), source="pz")
    repo.upsert_stage_document(pid, ws["id"], "specify", "# Spec\n\nBook.", "alice")
    return ws, pid


def _ready_for_repo(client: TestClient, ws, pid):
    client.app.state.github_client = FakeGithubClient()
    repo = client.app.state.repository
    repo.update_project_lifecycle_status(pid, "tech_review")
    repo.update_workspace(
        ws["id"],
        integration_config={
            "github": {
                "auth_kind": "pat",
                "owner": "acme",
                "owner_type": "Organization",
                "secret_ref": client.app.state.secret_store.encrypt("github_pat_test"),
            }
        },
    )


def test_inbox_lists_open_decisions_the_caller_can_resolve():
    with TestClient(create_app()) as client:
        ws, pid = _project(client)
        client.post(f"/projects/{pid}/decisions", json={"kind": "intent_approval"},
                    headers=BOB)

        mine = client.get("/me/decisions", headers=ALICE).json()
        bobs = client.get("/me/decisions", headers=BOB).json()

        assert [(i["project_name"], i["decision"]["kind"]) for i in mine] == [
            ("Rocket Ship", "intent_approval")
        ]
        assert mine[0]["workspace_name"] == "W"
        assert bobs == []
        filtered = client.get(f"/me/decisions?workspace_id={ws['id']}", headers=ALICE).json()
        assert len(filtered) == 1


def test_gate_off_keeps_todays_behaviour():
    with TestClient(create_app()) as client:
        ws, pid = _project(client)
        _ready_for_repo(client, ws, pid)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={},
                          headers=ALICE)

        assert res.status_code == 200, res.text


def test_gate_on_requires_rules_tasks_and_an_approved_current_plan(monkeypatch):
    with TestClient(create_app()) as client:
        # get_settings() is cached process-wide; monkeypatch restores the flag so
        # it cannot leak into later tests.
        monkeypatch.setattr(client.app.state.settings, "require_plan_approval", True)
        ws, pid = _project(client)
        _ready_for_repo(client, ws, pid)
        repo = client.app.state.repository
        url = f"/projects/{pid}/lifecycle/create-repository"

        assert client.post(url, json={}, headers=ALICE).json()["detail"] == "constitution_required"
        repo.upsert_stage_document(pid, ws["id"], "constitution", "# Rules\n\nBe kind.", "alice")
        assert client.post(url, json={}, headers=ALICE).json()["detail"] == "tasks_required"
        client.patch(f"/projects/{pid}/stage-documents/tasks", json={"content": TASKS},
                     headers=ALICE)
        blocked = client.post(url, json={}, headers=ALICE)
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == "plan_approval_required"
        assert client.app.state.github_client.created_repos == []

        did = client.post(f"/projects/{pid}/decisions", json={"kind": "plan_approval"},
                          headers=ALICE).json()["id"]
        client.post(f"/projects/{pid}/decisions/{did}/resolve",
                    json={"outcome": "approved"}, headers=ALICE)

        res = client.post(url, json={}, headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
