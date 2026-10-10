"""Approval rules for plan 0029 decisions: state from history, and who may
resolve. Pure functions, so every branch is pinned."""

from __future__ import annotations

from datetime import timedelta

from app.delivery.decisions import approval_state, can_resolve, content_hash
from app.models.schemas import Decision, ProjectRole, utcnow


def _decision(status="open", subject_hash="h1", kind="plan_approval", minutes_ago=0):
    return Decision(
        project_id="p", workspace_id="w", kind=kind, title="t", subject_stage="tasks",
        subject_hash=subject_hash, routed_hat="tech_steward", status=status,
        requested_by="u", created_at=utcnow() - timedelta(minutes=minutes_ago),
    )


def test_content_hash_ignores_surrounding_whitespace():
    assert content_hash("  # Tasks\n") == content_hash("# Tasks")
    assert len(content_hash("x")) == 64


def test_state_none_without_history_or_document():
    assert approval_state([], "plan_approval", "h1") == "none"
    assert approval_state([_decision()], "plan_approval", None) == "none"


def test_state_tracks_the_latest_non_withdrawn_decision_of_that_kind():
    history = [
        _decision(status="withdrawn", minutes_ago=0),
        _decision(status="approved", minutes_ago=5),
        _decision(status="rejected", minutes_ago=10),
        _decision(status="open", kind="intent_approval", minutes_ago=1),
    ]
    assert approval_state(history, "plan_approval", "h1") == "approved"


def test_state_pending_and_changes_requested():
    assert approval_state([_decision("open")], "plan_approval", "h1") == "pending"
    assert approval_state([_decision("rejected")], "plan_approval", "h1") == "changes_requested"


def test_an_edit_after_approval_or_request_is_stale():
    assert approval_state([_decision("approved", "old")], "plan_approval", "new") == "stale"
    assert approval_state([_decision("open", "old")], "plan_approval", "new") == "stale"


def _role(user_id):
    return ProjectRole(project_id="p", workspace_id="w", hat="tech_steward",
                       user_id=user_id, assigned_by="admin")


def test_the_hat_holder_resolves_and_admins_do_not_override_them():
    d = _decision()
    roles = [_role("steve")]
    assert can_resolve(d, "steve", roles, {"steve", "admin"}, is_admin=False)
    assert not can_resolve(d, "admin", roles, {"steve", "admin"}, is_admin=True)


def test_unassigned_hat_falls_back_to_admins():
    d = _decision()
    assert can_resolve(d, "admin", [], {"admin"}, is_admin=True)
    assert not can_resolve(d, "bob", [], {"admin", "bob"}, is_admin=False)


def test_a_holder_who_left_the_workspace_falls_back_to_admins():
    d = _decision()
    roles = [_role("gone")]
    assert can_resolve(d, "admin", roles, {"admin"}, is_admin=True)
    assert not can_resolve(d, "gone", roles, {"admin"}, is_admin=False)


def test_resolved_decisions_cannot_be_resolved_again():
    assert not can_resolve(_decision("approved"), "admin", [], {"admin"}, is_admin=True)
