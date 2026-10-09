"""How many repository calls the plan 0029 decision and delivery routes make.

Every repository method is one PostgREST request on the Supabase adapter
(`get_graph` is several), and the API and the database do not share a region,
so each call costs a cross-region round trip (~170-200 ms). These bounds pin
the counts after the dedupe in plan 0029's latency fix and the trust-test
wave 2 (both stage documents in one read; the caller's role taken from the
member list the routing context reads anyway); raising one should be a
deliberate choice, not an accident of a refactor. The two decision writes
each read the stage documents again after their write (one read more than
the minimum), so the snapshot and the approval mirror reflect an edit that
lands while the request runs.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.api.sync import _require_delivery_gates
from app.delivery.approvals import stage_hashes
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


class CountingRepository:
    """A transparent proxy that records each public repository call by name.
    Calls a repository method makes on itself go to the wrapped instance and
    are not counted — exactly as one Supabase method is one request."""

    def __init__(self, inner) -> None:
        self._inner = inner
        self.calls: list[str] = []

    def __getattr__(self, name: str):
        attr = getattr(self._inner, name)
        if name.startswith("_") or not callable(attr):
            return attr

        def counted(*args, **kwargs):
            self.calls.append(name)
            return attr(*args, **kwargs)

        return counted


@contextmanager
def counting(client: TestClient) -> Iterator[CountingRepository]:
    inner = client.app.state.repository
    proxy = CountingRepository(inner)
    client.app.state.repository = proxy
    try:
        yield proxy
    finally:
        client.app.state.repository = inner


def membership_reads(calls: list[str]) -> int:
    """Reads that answer "is the caller a member, and in what role"."""
    return calls.count("get_membership") + calls.count("list_members")


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
    res = client.patch(f"/projects/{pid}/stage-documents/tasks", json={"content": TASKS},
                       headers=ALICE)
    assert res.status_code == 200, res.text
    return pid


def test_requesting_a_decision(client, project):
    with counting(client) as repo:
        res = client.post(f"/projects/{project}/decisions", json={"kind": "intent_approval"},
                          headers=BOB)
    assert res.status_code == 200, res.text
    print("POST /decisions:", len(repo.calls), repo.calls)
    assert len(repo.calls) <= 7, repo.calls
    assert membership_reads(repo.calls) == 1, repo.calls


def test_approving_a_decision(client, project):
    did = client.post(f"/projects/{project}/decisions", json={"kind": "intent_approval"},
                      headers=BOB).json()["id"]
    with counting(client) as repo:
        res = client.post(f"/projects/{project}/decisions/{did}/resolve",
                          json={"outcome": "approved"}, headers=ALICE)
    assert res.status_code == 200, res.text
    print("POST /decisions/{id}/resolve:", len(repo.calls), repo.calls)
    assert len(repo.calls) <= 10, repo.calls
    assert membership_reads(repo.calls) == 1, repo.calls
    assert repo.calls.count("list_decisions") + repo.calls.count("get_decision") == 1


def test_listing_decisions(client, project):
    client.post(f"/projects/{project}/decisions", json={"kind": "intent_approval"},
                headers=BOB)
    with counting(client) as repo:
        res = client.get(f"/projects/{project}/decisions", headers=BOB)
    assert res.status_code == 200, res.text
    print("GET /decisions:", len(repo.calls), repo.calls)
    assert len(repo.calls) <= 5, repo.calls
    assert membership_reads(repo.calls) == 1, repo.calls
    assert repo.calls.count("list_decisions") == 1, repo.calls


def test_reading_the_delivery_plan(client, project):
    with counting(client) as repo:
        res = client.get(f"/projects/{project}/delivery-plan", headers=BOB)
    assert res.status_code == 200, res.text
    assert sum(len(c["task_ids"]) for c in res.json()["changes"]) == 2
    print("GET /delivery-plan:", len(repo.calls), repo.calls)
    assert len(repo.calls) <= 6, repo.calls
    assert "get_graph" not in repo.calls  # several requests on Supabase, not one


def test_reading_the_delivery_overview(client, project):
    client.post(f"/projects/{project}/decisions", json={"kind": "intent_approval"},
                headers=BOB)
    with counting(client) as repo:
        res = client.get(f"/projects/{project}/delivery-overview", headers=BOB)
    assert res.status_code == 200, res.text
    print("GET /delivery-overview:", len(repo.calls), repo.calls)
    # The plan, the decisions and the roles together, for no more than the
    # decisions alone plus the plan's two reads: one membership check, one
    # read of the decisions, one of the stage documents, one of the roles.
    assert len(repo.calls) <= 7, repo.calls
    assert membership_reads(repo.calls) == 1, repo.calls
    assert repo.calls.count("list_decisions") == 1, repo.calls
    assert repo.calls.count("list_project_roles") == 1, repo.calls
    assert repo.calls.count("list_stage_documents") == 1, repo.calls
    assert "get_stage_document" not in repo.calls and "get_graph" not in repo.calls


def test_listing_my_inbox_reads_no_stage_documents(client, project):
    client.post(f"/projects/{project}/decisions", json={"kind": "intent_approval"},
                headers=BOB)
    with counting(client) as repo:
        res = client.get("/me/decisions", headers=ALICE)
    assert res.status_code == 200, res.text
    (item,) = res.json()
    # The inbox lists open decisions only: it neither needs the stage hashes
    # (is_current) nor ships the document text (subject_content).
    assert "is_current" not in item["decision"] and "subject_content" not in item["decision"]
    print("GET /me/decisions:", len(repo.calls), repo.calls)
    assert repo.calls.count("get_stage_document") == 0, repo.calls
    assert repo.calls.count("list_decisions") == 1, repo.calls
    assert len(repo.calls) <= 5, repo.calls



def test_stage_hashes_makes_one_repository_call(client, project):
    with counting(client) as repo:
        hashes = stage_hashes(repo, project)
    assert repo.calls == ["list_stage_documents"]
    assert set(hashes) == {"specify", "tasks"}
    assert hashes["specify"] is not None and hashes["tasks"] is not None


def test_the_create_repository_gate_reads_the_stage_documents_once(client, project):
    inner = client.app.state.repository
    pid = project
    ws = inner.get_project(pid).workspace_id
    inner.upsert_stage_document(pid, ws, "constitution", "# Rules", "alice")
    did = client.post(f"/projects/{pid}/decisions", json={"kind": "plan_approval"},
                      headers=BOB).json()["id"]
    res = client.post(f"/projects/{pid}/decisions/{did}/resolve",
                      json={"outcome": "approved"}, headers=ALICE)
    assert res.status_code == 200, res.text
    with counting(client) as repo:
        _require_delivery_gates(repo, pid)  # passes: constitution, tasks, approved plan
    print("create-repository gates:", len(repo.calls), repo.calls)
    assert repo.calls == ["list_stage_documents", "list_decisions"], repo.calls
