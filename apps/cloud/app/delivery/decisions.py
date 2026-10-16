"""Approval rules for plan 0029 decisions (M2).

A decision approves one stage document as it was when requested
(`subject_hash`). The state a project shows comes from the latest
non-withdrawn decision of that kind compared with the document as it is now.
Routing: the user wearing the decision's hat resolves it; when nobody wears
the hat, or the wearer has left the workspace, workspace admins do.
The requester never resolves their own decision (v2.1 View 1: no
self-approval), even when they are the only person who could.
"""

from __future__ import annotations

import hashlib
from collections.abc import Collection
from typing import Literal

from app.models.schemas import Decision, ProjectRole

ApprovalState = Literal["none", "pending", "approved", "stale", "changes_requested"]

STAGE_OF: dict[str, str] = {"intent_approval": "specify", "plan_approval": "tasks"}
HAT_OF: dict[str, str] = {"intent_approval": "business_owner", "plan_approval": "tech_steward"}
TITLE_OF: dict[str, str] = {
    "intent_approval": "Approve the intent",
    "plan_approval": "Approve the delivery plan",
}


def content_hash(content: str) -> str:
    return hashlib.sha256(content.strip().encode("utf-8")).hexdigest()


def latest_decision(decisions: list[Decision], kind: str) -> Decision | None:
    """The newest non-withdrawn decision of `kind` — the one a state reads."""
    return max(
        (d for d in decisions if d.kind == kind and d.status != "withdrawn"),
        key=lambda d: (d.created_at, d.id),
        default=None,
    )


def approval_state(
    decisions: list[Decision], kind: str, current_hash: str | None
) -> ApprovalState:
    if current_hash is None:
        return "none"
    latest = latest_decision(decisions, kind)
    if latest is None:
        return "none"
    if latest.status == "rejected":
        return "changes_requested"
    if latest.subject_hash != current_hash:
        return "stale"
    return "pending" if latest.status == "open" else "approved"


Blocked = Literal["own_request", "no_approver"]


def eligible_resolvers(
    decision: Decision,
    roles: list[ProjectRole],
    member_ids: Collection[str],
    admin_ids: Collection[str],
) -> set[str]:
    """Everyone who may resolve `decision`: the hat holder while they are a
    member, otherwise the workspace admins. Never the requester."""
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    pool = {holder} if holder is not None and holder in member_ids else set(admin_ids)
    return pool - {decision.requested_by}


def blocked_reason(
    decision: Decision,
    user_id: str,
    roles: list[ProjectRole],
    member_ids: Collection[str],
    admin_ids: Collection[str],
) -> Blocked | None:
    """Why an open decision is stuck, as `user_id` should be told: nobody but
    the requester could approve it, or `user_id` is the requester."""
    if decision.status != "open":
        return None
    if not eligible_resolvers(decision, roles, member_ids, admin_ids):
        return "no_approver"
    if user_id == decision.requested_by:
        return "own_request"
    return None


def can_resolve(
    decision: Decision,
    user_id: str,
    roles: list[ProjectRole],
    member_ids: set[str],
    is_admin: bool,
) -> bool:
    if decision.status != "open" or user_id == decision.requested_by:
        return False
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    if holder is not None and holder in member_ids:
        return holder == user_id
    return is_admin
