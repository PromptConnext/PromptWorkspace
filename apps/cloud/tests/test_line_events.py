"""LINE messages for decisions (plan 0032 Task 5)."""

from __future__ import annotations

from concurrent.futures import Executor, Future
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db.repository import InMemoryRepository
from app.delivery.sweep import sweep_decisions
from app.integrations.line import LineNotifier, RecordingLineClient
from app.main import create_app
from app.models.schemas import (
    Decision,
    GraphUpsertRequest,
    ProjectLineLink,
    Requirement,
    Role,
    SpecDocument,
    utcnow,
)

ALICE = {"X-User-Id": "alice"}  # admin
BOB = {"X-User-Id": "bob"}  # member
GROUP = "C123"


class InlineExecutor(Executor):
    def submit(self, fn, /, *args, **kwargs):
        future: Future = Future()
        future.set_result(fn(*args, **kwargs))
        return future


def _link(repo, project_id: str) -> None:
    repo.set_project_line_link(
        ProjectLineLink(project_id=project_id, group_id=GROUP, linked_by="alice",
                        linked_at=utcnow()))


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
    _link(repo, pid)
    return pid


@pytest.fixture
def line(client) -> RecordingLineClient:
    recorder = RecordingLineClient()
    client.app.state.line_notifier = LineNotifier(
        recorder, client.app.state.repository, InlineExecutor())
    return recorder


def _request(client, pid, headers=BOB):
    return client.post(f"/projects/{pid}/decisions", json={"kind": "intent_approval"},
                       headers=headers)


def _resolve(client, pid, did, outcome="approved", rationale=None, headers=ALICE):
    return client.post(f"/projects/{pid}/decisions/{did}/resolve",
                       json={"outcome": outcome, "rationale": rationale}, headers=headers)


def test_request_pushes_requested_message_naming_the_holder(client, project, line):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": "alice"},
               headers=ALICE)

    _request(client, project)

    ((to, text),) = line.pushed
    assert to == GROUP
    assert "waiting for alice@promptworkspace.local (business owner)" in text
    assert "/decisions" in text or "http" in text


def test_request_without_holder_names_any_admin(client, project, line):
    _request(client, project)

    ((_, text),) = line.pushed
    assert "any workspace admin" in text


def test_changes_requested_pushes_reason(client, project, line):
    did = _request(client, project).json()["id"]
    line.pushed.clear()

    _resolve(client, project, did, outcome="rejected", rationale="Add cancellations.")

    ((to, text),) = line.pushed
    assert to == GROUP
    assert "alice@promptworkspace.local requested changes" in text
    assert "Add cancellations." in text


def test_approval_pushes_approved(client, project, line):
    did = _request(client, project).json()["id"]
    line.pushed.clear()

    _resolve(client, project, did)

    ((to, text),) = line.pushed
    assert to == GROUP
    assert "alice@promptworkspace.local approved the intent" in text


def test_no_push_when_project_unlinked(client, project, line):
    client.app.state.repository.delete_project_line_link(project)

    did = _request(client, project).json()["id"]
    _resolve(client, project, did)

    assert line.pushed == []


def _sweep_setup(hours_left: float):
    repo = InMemoryRepository()
    ws = repo.create_workspace("W", "alice", created_by_email="alice@x.com")
    repo.add_member(ws.id, "bob", Role.member, email="bob@x.com")
    project = repo.create_project(ws.id, "alice", "Clinic")
    _link(repo, project.id)
    now = utcnow()
    repo.save_decision(Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval",
        title="Approve the intent", subject_stage="specify", subject_hash="h",
        routed_hat="business_owner", requested_by="bob",
        created_at=now - timedelta(days=7), expires_at=now + timedelta(hours=hours_left)))
    recorder = RecordingLineClient()
    return repo, LineNotifier(recorder, repo, InlineExecutor()), recorder, now


def test_sweep_pushes_reminder_and_expired_once():
    from app.decision_email import RecordingDecisionMailer

    settings = Settings(decision_reminder_hours=48, web_app_url="https://w.example")
    repo, notifier, recorder, now = _sweep_setup(hours_left=10)
    mailer = RecordingDecisionMailer()

    sweep_decisions(repo, mailer, settings, now, notifier)
    sweep_decisions(repo, mailer, settings, now, notifier)
    ((_, text),) = recorder.pushed
    assert "Reminder" in text and "any workspace admin" in text

    recorder.pushed.clear()
    sweep_decisions(repo, mailer, settings, now + timedelta(hours=11), notifier)
    sweep_decisions(repo, mailer, settings, now + timedelta(hours=11), notifier)
    ((_, text),) = recorder.pushed
    assert "counts as not approved" in text
