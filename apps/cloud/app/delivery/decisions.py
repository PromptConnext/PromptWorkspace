"""Approval rules for plan 0029 decisions (M2).

A decision approves one stage document as it was when requested
(`subject_hash`). The state a project shows comes from the latest
non-withdrawn decision of that kind compared with the document as it is now.
Routing: the user wearing the decision's hat resolves it; when nobody wears
the hat, or the wearer has left the workspace, workspace admins do.
"""

from __future__ import annotations

import hashlib
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


def approval_state(
    decisions: list[Decision], kind: str, current_hash: str | None
) -> ApprovalState:
    if current_hash is None:
        return "none"
    history = sorted(
        (d for d in decisions if d.kind == kind and d.status != "withdrawn"),
        key=lambda d: (d.created_at, d.id),
        reverse=True,
    )
    if not history:
        return "none"
    latest = history[0]
    if latest.status == "rejected":
        return "changes_requested"
    if latest.subject_hash != current_hash:
        return "stale"
    return "pending" if latest.status == "open" else "approved"


def can_resolve(
    decision: Decision,
    user_id: str,
    roles: list[ProjectRole],
    member_ids: set[str],
    is_admin: bool,
) -> bool:
    if decision.status != "open":
        return False
    holder = next((r.user_id for r in roles if r.hat == decision.routed_hat), None)
    if holder is not None and holder in member_ids:
        return holder == user_id
    return is_admin
