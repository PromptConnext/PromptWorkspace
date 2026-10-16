"""Approval rules for plan 0029 decisions: state from history, and who may
resolve. Pure functions, so every branch is pinned."""

from __future__ import annotations

from datetime import timedelta

from app.delivery.decisions import (
    approval_state,
    blocked_reason,
    can_resolve,
    content_hash,
    eligible_resolvers,
    is_overdue,
)
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


def test_the_requester_never_resolves_their_own_decision():
    d = _decision()  # requested_by="u"
    assert not can_resolve(d, "u", [], {"u"}, is_admin=True)
    assert not can_resolve(d, "u", [_role("u")], {"u"}, is_admin=False)


def test_eligible_resolvers_exclude_the_requester():
    d = _decision()
    assert eligible_resolvers(d, [], {"u", "a1", "a2"}, {"u", "a1", "a2"}) == {"a1", "a2"}
    assert eligible_resolvers(d, [_role("steve")], {"steve"}, {"a1"}) == {"steve"}
    assert eligible_resolvers(d, [_role("u")], {"u", "a1"}, {"a1"}) == set()


def test_a_solo_admin_request_has_no_approver():
    d = _decision()
    assert blocked_reason(d, "u", [], {"u"}, {"u"}) == "no_approver"


def test_the_requester_sees_own_request_when_someone_else_can_approve():
    d = _decision()
    assert blocked_reason(d, "u", [], {"u", "a1"}, {"a1"}) == "own_request"
    assert blocked_reason(d, "a1", [], {"u", "a1"}, {"a1"}) is None


def test_a_resolved_decision_is_never_blocked():
    assert blocked_reason(_decision("approved"), "u", [], {"u"}, {"u"}) is None


def test_an_expired_decision_reads_like_no_decision():
    assert approval_state([_decision("expired")], "plan_approval", "h1") == "none"
    older = _decision("rejected", minutes_ago=5)
    assert approval_state([older, _decision("expired")], "plan_approval", "h1") == \
        "changes_requested"


def test_overdue_means_open_and_past_expiry():
    now = utcnow()
    assert is_overdue(_decision().model_copy(update={"expires_at": now}), now)
    assert not is_overdue(_decision().model_copy(
        update={"expires_at": now + timedelta(seconds=1)}), now)
    assert not is_overdue(_decision("approved").model_copy(update={"expires_at": now}), now)
    assert not is_overdue(_decision(), now)  # no expiry recorded (pre-0009)
