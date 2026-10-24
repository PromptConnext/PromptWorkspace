"""People links for the workspace overview (plan 0033 spec 3). Pure: no I/O."""

from __future__ import annotations

from collections import Counter

from app.models.schemas import Decision, PersonLinkOut, ProjectRole, TaskSummary

_RESOLVED = {"approved", "rejected"}


def _key(link: PersonLinkOut) -> tuple[str, str, str]:
    return (link.project_id or "", link.from_user_id, link.to_user_id or "")


def build_links(
    roles_by_project: dict[str, list[ProjectRole]],
    tasks: list[TaskSummary],
    decisions_by_project: dict[str, list[Decision]],
) -> list[PersonLinkOut]:
    """Hat, work and approval edges, ordered hats, work, approval; each kind
    sorted by (project_id, from_user_id, to_user_id)."""
    hats = [
        PersonLinkOut(
            kind="hat",
            from_user_id=r.user_id,
            project_id=r.project_id,
            hat=r.hat,
            weight=1,
        )
        for roles in roles_by_project.values()
        for r in roles
        if r.user_id
    ]

    work_counts = Counter(
        (t.project_id, t.assigned_user_id) for t in tasks if t.assigned_user_id
    )
    work = [
        PersonLinkOut(kind="work", from_user_id=user, project_id=pid, weight=n)
        for (pid, user), n in work_counts.items()
    ]

    approval_counts = Counter(
        (d.requested_by, d.resolved_by)
        for decisions in decisions_by_project.values()
        for d in decisions
        if d.resolved_by and d.status in _RESOLVED and d.requested_by != d.resolved_by
    )
    approvals = [
        PersonLinkOut(kind="approval", from_user_id=a, to_user_id=b, weight=n)
        for (a, b), n in approval_counts.items()
    ]

    return sorted(hats, key=_key) + sorted(work, key=_key) + sorted(approvals, key=_key)
