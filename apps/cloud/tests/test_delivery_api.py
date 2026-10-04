"""GET /projects/{id}/delivery-plan and the project-roles routes (plan 0029)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import GraphUpsertRequest, Requirement, SpecDocument

ALICE = {"X-User-Id": "alice"}  # creator, admin
BOB = {"X-User-Id": "bob"}  # member
MALLORY = {"X-User-Id": "mallory"}  # not a member

TASKS = """# Tasks

Enough prose here for the document parser's minimum-length check to accept this as a
real generated document rather than a token stub.

## Phase 1: Setup
- [ ] T001 Create the project
## Phase 2: User Story 1 - Book (Priority: P1)
- [ ] T002 Implement booking
## Phase 3: User Story 2 - Remind (Priority: P2)
- [ ] T003 Send reminders
## Phase 4: Polish
- [ ] T004 README
"""


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def project(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200, accept.text
    pid = client.post("/projects", json={"name": "P", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    repo = client.app.state.repository
    requirement = Requirement(project_id=pid, title="Booking")
    repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")
    spec = SpecDocument(project_id=pid, requirement_id=requirement.id, content="# Spec")
    repo.upsert_graph(pid, GraphUpsertRequest(spec_documents=[spec]), source="pz")
    return pid


def _save_tasks(client: TestClient, pid: str, content: str = TASKS) -> None:
    res = client.patch(f"/projects/{pid}/stage-documents/tasks", json={"content": content},
                       headers=ALICE)
    assert res.status_code == 200, res.text


def test_delivery_plan_is_empty_before_tasks(client, project):
    res = client.get(f"/projects/{project}/delivery-plan", headers=BOB)
    assert res.status_code == 200
    assert res.json() == {"changes": [], "plan_approval": "none"}


def test_delivery_plan_lists_changes_with_waves_dependencies_and_tasks(client, project):
    _save_tasks(client, project)

    body = client.get(f"/projects/{project}/delivery-plan", headers=BOB).json()

    rows = [(c["ref"], c["kind"], c["wave"], c["depends_on"]) for c in body["changes"]]
    assert rows == [
        ("C1", "setup", 0, []),
        ("C2", "story", 1, ["C1"]),
        ("C3", "story", 1, ["C1"]),
        ("C4", "polish", 2, ["C2", "C3"]),
    ]
    assert body["changes"][1]["priority"] == "P1"
    assert len(body["changes"][0]["task_ids"]) == 1
    assert body["plan_approval"] == "none"


def test_delivery_plan_requires_membership(client, project):
    assert client.get(f"/projects/{project}/delivery-plan", headers=MALLORY).status_code == 403


def test_roles_default_to_unassigned(client, project):
    res = client.get(f"/projects/{project}/roles", headers=BOB)
    assert res.json() == [
        {"hat": "business_owner", "user_id": None},
        {"hat": "tech_steward", "user_id": None},
    ]


def test_admin_assigns_and_clears_a_hat(client, project):
    res = client.put(f"/projects/{project}/roles/business_owner", json={"user_id": "bob"},
                     headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()[0] == {"hat": "business_owner", "user_id": "bob"}

    cleared = client.put(f"/projects/{project}/roles/business_owner", json={"user_id": None},
                         headers=ALICE)
    assert cleared.json()[0] == {"hat": "business_owner", "user_id": None}


def test_only_admins_assign_hats(client, project):
    res = client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": "bob"},
                     headers=BOB)
    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"


def test_a_hat_goes_only_to_a_workspace_member(client, project):
    res = client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": "mallory"},
                     headers=ALICE)
    assert res.status_code == 400
    assert res.json()["detail"] == "role_user_not_a_member"


def test_unknown_hat_is_422(client, project):
    res = client.put(f"/projects/{project}/roles/dictator", json={"user_id": "bob"},
                     headers=ALICE)
    assert res.status_code == 422


def test_unavailable_store_is_503(client, project, monkeypatch):
    from app.db.repository import DeliveryStoreUnavailable

    def boom(*_a, **_k):
        raise DeliveryStoreUnavailable()

    monkeypatch.setattr(client.app.state.repository, "set_project_role", boom)
    res = client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": "bob"},
                     headers=ALICE)
    assert res.status_code == 503
    assert res.json()["detail"] == "delivery_store_unavailable"
