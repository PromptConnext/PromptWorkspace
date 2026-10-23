"""The decision sweep (D1): reminders before expiry, expiry with a receipt."""

from __future__ import annotations

from datetime import timedelta

from app.config import Settings
from app.db.repository import InMemoryRepository
from app.decision_email import RecordingDecisionMailer
from app.delivery.sweep import sweep_decisions
from app.models.schemas import Decision, Role, utcnow

SETTINGS = Settings(decision_reminder_hours=48, web_app_url="https://w.example")


def _setup(hours_left: float, reminded=False):
    repo = InMemoryRepository()
    ws = repo.create_workspace("W", "alice", created_by_email="alice@x.com")
    repo.add_member(ws.id, "bob", Role.member, email="bob@x.com")
    project = repo.create_project(ws.id, "alice", "Clinic")
    now = utcnow()
    d = repo.save_decision(Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval",
        title="Approve the intent", subject_stage="specify", subject_hash="h",
        routed_hat="business_owner", requested_by="bob",
        created_at=now - timedelta(days=7),
        expires_at=now + timedelta(hours=hours_left),
        reminded_at=now if reminded else None))
    return repo, project, d, now


def test_a_decision_far_from_expiry_is_left_alone():
    repo, _, d, now = _setup(hours_left=100)
    mailer = RecordingDecisionMailer()
    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 0)
    assert mailer.sent == []


def test_a_decision_close_to_expiry_reminds_the_deciders_once():
    repo, project, d, now = _setup(hours_left=10)
    mailer = RecordingDecisionMailer()

    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 1)
    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 0)

    ((to, subject, _),) = mailer.sent
    assert to == ["alice@x.com"] and subject.startswith("[PromptWorkspace] Reminder")
    assert repo.get_decision(project.id, d.id).reminded_at is not None


def test_an_overdue_decision_expires_tells_the_requester_and_leaves_a_receipt():
    repo, project, d, now = _setup(hours_left=-1, reminded=True)
    mailer = RecordingDecisionMailer()

    assert sweep_decisions(repo, mailer, SETTINGS, now) == (1, 0)

    stored = repo.get_decision(project.id, d.id)
    assert stored.status == "expired" and stored.resolved_at == now
    assert [r.event for r in repo.list_receipts(project.id)] == [
        "decision.requested", "decision.expired"]
    ((to, subject, _),) = mailer.sent
    assert to == ["bob@x.com"] and subject.startswith("[PromptWorkspace] Expired")


def test_a_decision_resolved_after_the_read_is_not_reverted(monkeypatch):
    repo, project, d, now = _setup(hours_left=-1)
    stale = repo.get_decision(project.id, d.id)
    repo.save_decision(d.model_copy(update={"status": "approved", "resolved_by": "alice"}))
    monkeypatch.setattr(repo, "list_due_decisions", lambda *a, **k: [stale])
    mailer = RecordingDecisionMailer()

    assert sweep_decisions(repo, mailer, SETTINGS, now) == (0, 0)

    stored = repo.get_decision(project.id, d.id)
    assert stored.status == "approved" and stored.resolved_by == "alice"
    assert mailer.sent == []


def test_one_failing_decision_does_not_stop_the_pass(monkeypatch):
    repo, project, d, now = _setup(hours_left=-1)
    bad_project = repo.create_project(project.workspace_id, "alice", "Other")
    bad = repo.save_decision(Decision(
        project_id=bad_project.id, workspace_id=project.workspace_id, kind="intent_approval",
        title="t", subject_stage="specify", subject_hash="h", routed_hat="business_owner",
        requested_by="bob", expires_at=now - timedelta(hours=5)))
    real = repo.get_project

    def get_project(pid):
        if pid == bad_project.id:
            raise RuntimeError("boom")
        return real(pid)

    monkeypatch.setattr(repo, "get_project", get_project)
    assert repo.list_due_decisions(now)[0].id == bad.id  # the failing one goes first

    assert sweep_decisions(repo, RecordingDecisionMailer(), SETTINGS, now) == (1, 0)
    assert repo.get_decision(project.id, d.id).status == "expired"
    assert "decision.expired" in [r.event for r in repo.list_receipts(project.id)]
