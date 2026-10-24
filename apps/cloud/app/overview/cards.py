"""Build one workspace-overview project card (plan 0033). Pure: no I/O."""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta

from app.models.schemas import (
    Decision,
    Project,
    ProjectCardOut,
    ProjectRole,
    RepoAnalysis,
    TaskStatus,
    TaskSummary,
    WorkspaceGovernance,
)
from app.overview.checks import decision_counts, run_checks

_AGENT_WINDOW = timedelta(days=30)


def build_card(
    project: Project,
    roles: list[ProjectRole],
    tasks: list[TaskSummary],
    decisions: list[Decision],
    analysis: RepoAnalysis | None,
    governance: WorkspaceGovernance,
    latest_receipt_at: datetime | None,
    now: datetime,
) -> ProjectCardOut:
    task_counts = {s.value: 0 for s in TaskStatus}
    for t in tasks:
        task_counts[t.status.value] += 1

    per_user = Counter(t.assigned_user_id for t in tasks if t.assigned_user_id)
    contributors = [u for u, _ in sorted(per_user.items(), key=lambda kv: (-kv[1], kv[0]))]

    stack = None
    if analysis is not None:
        s = analysis.snapshot.stack
        stack = {"runtime": s.runtime, "languages": s.languages[:3]}

    state = project.deployment_state
    live_url = state.url if state is not None and state.state == "live" else None

    activity = [project.updated_at, *(t.updated_at for t in tasks)]
    if latest_receipt_at is not None:
        activity.append(latest_receipt_at)

    hats = {"business_owner": None, "tech_steward": None}
    for r in roles:
        hats[r.hat] = r.user_id

    return ProjectCardOut(
        id=project.id,
        name=project.name,
        lifecycle_status=project.lifecycle_status,
        live_url=live_url,
        updated_at=project.updated_at,
        hats=hats,
        contributors=contributors,
        task_counts=task_counts,
        decisions=decision_counts(decisions, now),
        stack=stack,
        # policy_scope_source is added to Project by Task 9; "project" until then.
        policy={
            "source": getattr(project, "policy_scope_source", "project"),
            "selected": list(project.policy_scope.selected) if project.policy_scope else [],
        },
        checks=run_checks(project, roles, decisions, governance, now),
        agent_closed_30d=sum(
            1 for t in tasks if t.agent_closed and now - t.updated_at <= _AGENT_WINDOW
        ),
        last_activity_at=max(activity),
    )
