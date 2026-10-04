"""Approval decisions (plan 0029 M2): request, list, resolve, and what an
approval writes to the graph."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import GraphUpsertRequest, Requirement, SpecDocument

ALICE = {"X-User-Id": "alice"}  # admin
BOB = {"X-User-Id": "bob"}  # member

TASKS = """# Tasks

Enough prose here for the document parser's minimum-length check to accept this as a
real generated document rather than a token stub.

## Phase 1: Setup
- [ ] T001 Create the project
## Phase 2: User Story 1 - Book (Priority: P1)
- [ ] T002 Implement booking
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
    client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    pid = client.post("/projects", json={"name": "P", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    repo = client.app.state.repository
    requirement = Requirement(project_id=pid, title="Booking")
    repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")
    spec = SpecDocument(project_id=pid, requirement_id=requirement.id, content="# Spec")
    repo.upsert_graph(pid, GraphUpsertRequest(spec_documents=[spec]), source="pz")
    repo.upsert_stage_document(pid, ws["id"], "specify", "# Spec\n\nBook a slot.", "alice")
    return pid


def _save_tasks(client, pid, content=TASKS):
    res = client.patch(f"/projects/{pid}/stage-documents/tasks", json={"content": content},
                       headers=ALICE)
    assert res.status_code == 200, res.text


def _request(client, pid, kind, headers=BOB):
    return client.post(f"/projects/{pid}/decisions", json={"kind": kind}, headers=headers)


def _resolve(client, pid, did, outcome="approved", rationale=None, headers=ALICE):
    return client.post(f"/projects/{pid}/decisions/{did}/resolve",
                       json={"outcome": outcome, "rationale": rationale}, headers=headers)


def test_any_member_requests_intent_approval_routed_to_the_business_owner(client, project):
    res = _request(client, project, "intent_approval")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["kind"] == "intent_approval"
    assert body["routed_hat"] == "business_owner"
    assert body["status"] == "open"
    assert body["requested_by"] == "bob"
    assert body["can_resolve"] is False  # bob is not an admin and holds no hat


def test_requesting_twice_on_the_same_content_returns_the_same_decision(client, project):
    first = _request(client, project, "intent_approval").json()
    second = _request(client, project, "intent_approval").json()

    assert first["id"] == second["id"]
    listing = client.get(f"/projects/{project}/decisions", headers=BOB).json()
    assert len(listing["decisions"]) == 1


def test_requesting_after_an_edit_withdraws_the_old_request(client, project):
    first = _request(client, project, "intent_approval").json()
    repo = client.app.state.repository
    ws_id = repo.get_project(project).workspace_id
    repo.upsert_stage_document(project, ws_id, "specify", "# Spec\n\nBook and cancel.", "alice")

    second = _request(client, project, "intent_approval").json()

    assert second["id"] != first["id"]
    old = repo.get_decision(project, first["id"])
    assert old is not None and old.status == "withdrawn"


def test_no_document_means_nothing_to_approve(client, project):
    res = _request(client, project, "plan_approval")
    assert res.status_code == 409
    assert res.json()["detail"] == "decision_subject_missing"


def test_plan_approval_needs_a_delivery_plan(client, project, monkeypatch):
    _save_tasks(client, project)
    monkeypatch.setattr(client.app.state.repository, "list_delivery_changes",
                        lambda *_a, **_k: [])
    res = _request(client, project, "plan_approval")
    assert res.status_code == 409
    assert res.json()["detail"] == "delivery_plan_missing"


def test_admin_approves_intent_when_no_business_owner_and_the_requirement_is_approved(
    client, project
):
    did = _request(client, project, "intent_approval").json()["id"]

    res = _resolve(client, project, did)

    assert res.status_code == 200, res.text
    assert res.json()["status"] == "approved"
    assert res.json()["resolved_by"] == "alice"
    requirement = client.app.state.repository.get_latest_requirement(project)
    assert requirement.status == "approved"
    states = client.get(f"/projects/{project}/decisions", headers=BOB).json()["states"]
    assert states == {"intent": "approved", "plan": "none"}


def test_plan_approval_marks_the_spec_approved_by_the_steward(client, project):
    _save_tasks(client, project)
    client.put(f"/projects/{project}/roles/tech_steward", json={"user_id": "bob"},
               headers=ALICE)
    did = _request(client, project, "plan_approval", headers=ALICE).json()["id"]

    res = _resolve(client, project, did, headers=BOB)

    assert res.status_code == 200, res.text
    spec = client.app.state.repository.get_latest_spec_document(project)
    assert spec.status == "approved" and spec.approved_by == "bob"
    plan = client.get(f"/projects/{project}/delivery-plan", headers=BOB).json()
    assert plan["plan_approval"] == "approved"


def test_only_the_routed_person_resolves(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": "bob"},
               headers=ALICE)
    did = _request(client, project, "intent_approval", headers=ALICE).json()["id"]

    res = _resolve(client, project, did, headers=ALICE)

    assert res.status_code == 403
    assert res.json()["detail"] == "decision_not_routed_to_you"


def test_document_changed_since_the_request_is_409(client, project):
    did = _request(client, project, "intent_approval").json()["id"]
    repo = client.app.state.repository
    ws_id = repo.get_project(project).workspace_id
    repo.upsert_stage_document(project, ws_id, "specify", "# Spec\n\nSomething else.", "alice")

    res = _resolve(client, project, did)

    assert res.status_code == 409
    assert res.json()["detail"] == "decision_subject_changed"
    assert repo.get_decision(project, did).status == "open"


def test_requesting_changes_needs_a_rationale(client, project):
    did = _request(client, project, "intent_approval").json()["id"]

    missing = _resolve(client, project, did, outcome="rejected", rationale="  ")
    assert missing.status_code == 422
    assert missing.json()["detail"] == "rationale_required"

    ok = _resolve(client, project, did, outcome="rejected", rationale="Add cancellations.")
    assert ok.status_code == 200
    states = client.get(f"/projects/{project}/decisions", headers=BOB).json()["states"]
    assert states["intent"] == "changes_requested"


def test_a_resolved_decision_cannot_be_resolved_again(client, project):
    did = _request(client, project, "intent_approval").json()["id"]
    _resolve(client, project, did)

    again = _resolve(client, project, did, outcome="rejected", rationale="late")

    assert again.status_code == 409
    assert again.json()["detail"] == "decision_not_open"


def test_unknown_decision_is_404(client, project):
    res = _resolve(client, project, "00000000-0000-4000-8000-0000000000ff")
    assert res.status_code == 404
    assert res.json()["detail"] == "decision_not_found"


def test_editing_tasks_after_plan_approval_makes_it_stale(client, project):
    _save_tasks(client, project)
    did = _request(client, project, "plan_approval").json()["id"]
    _resolve(client, project, did)

    _save_tasks(client, project, TASKS + "## Phase 3: Polish\n- [ ] T003 README\n")

    plan = client.get(f"/projects/{project}/delivery-plan", headers=BOB).json()
    assert plan["plan_approval"] == "stale"
