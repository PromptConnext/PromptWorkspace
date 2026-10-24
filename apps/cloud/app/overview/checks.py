"""Governance checks for one project (plan 0033 §4.3). Pure: no I/O.

`rules_in_repo` is deliberately absent; it is evaluated client-side.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.models.schemas import (
    Decision,
    Project,
    ProjectCheckOut,
    ProjectRole,
    WorkspaceGovernance,
)

_HAT_LABELS = {"business_owner": "business owner", "tech_steward": "tech steward"}
_HAT_ORDER = ("business_owner", "tech_steward")
EXPIRED_WINDOW = timedelta(days=30)


def decision_counts(decisions: list[Decision], now: datetime) -> dict[str, int]:
    open_n = overdue = expired = 0
    for d in decisions:
        if d.status == "open":
            open_n += 1
            if d.expires_at is not None and d.expires_at < now:
                overdue += 1
        elif d.status == "expired":
            at = d.resolved_at or d.expires_at
            if at is not None and now - at <= EXPIRED_WINDOW:
                expired += 1
    return {"open": open_n, "overdue": overdue, "expired_30d": expired}


def run_checks(
    project: Project,
    roles: list[ProjectRole],
    decisions: list[Decision],
    governance: WorkspaceGovernance,
    now: datetime,
) -> list[ProjectCheckOut]:
    out: list[ProjectCheckOut] = []
    held = {r.hat for r in roles}
    for hat in _HAT_ORDER:
        if hat not in governance.required_hats:
            continue
        label = _HAT_LABELS.get(hat, hat)
        ok = hat in held
        out.append(
            ProjectCheckOut(
                id=f"hat_{hat}",
                ok=ok,
                text=f"Has a {label} assigned" if ok else f"No {label} assigned",
            )
        )

    project_sel = list(project.policy_scope.selected) if project.policy_scope else []
    ws_sel = governance.policy_scope.selected
    if ws_sel:
        ok = set(project_sel) == set(ws_sel)
        out.append(
            ProjectCheckOut(
                id="policy_matches_workspace",
                ok=ok,
                text="Policy scope matches the workspace"
                if ok
                else "Policy scope differs from the workspace",
            )
        )
    elif not project_sel:
        out.append(ProjectCheckOut(id="policy_empty", ok=False, text="No policy scope set"))

    counts = decision_counts(decisions, now)
    n = counts["overdue"] + counts["expired_30d"]
    if n == 0:
        text = "No decisions past their due date"
    elif n == 1:
        text = "1 decision past its due date"
    else:
        text = f"{n} decisions past their due date"
    out.append(ProjectCheckOut(id="decisions_overdue", ok=n == 0, text=text))
    return out
