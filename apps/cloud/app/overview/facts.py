"""Facts for "ask the workspace" (plan 0033 task 20). Pure: no I/O.

`facts_to_text` is the ONLY context the question box sends to a model. It holds
project names, hat names, counts and decision kinds, never document text,
discussion bodies or decision snapshots.
"""

from __future__ import annotations

from app.models.schemas import (
    AskDecisionFact,
    AskMissingHatsFact,
    AskOverdueFact,
    Decision,
    WorkspaceFacts,
    WorkspaceOverviewOut,
)

__all__ = ["WorkspaceFacts", "compute_workspace_facts", "facts_to_text"]


def compute_workspace_facts(
    overview: WorkspaceOverviewOut, user_id: str, my_decisions: list[Decision]
) -> WorkspaceFacts:
    # `user_id` is the caller; `my_decisions` is already limited to what is
    # routed to them, so it is only used to scope the facts to one person.
    names = {p.id: p.name for p in overview.projects}
    mine = [
        AskDecisionFact(
            project_id=d.project_id,
            project_name=names.get(d.project_id, ""),
            kind=str(d.kind),
            expires_at=d.expires_at,
        )
        for d in my_decisions
        if d.project_id in names
    ]
    missing: list[AskMissingHatsFact] = []
    overdue: list[AskOverdueFact] = []
    by_runtime: dict[str, list[str]] = {}
    closed = 0
    for p in overview.projects:
        gaps = [hat for hat, holder in p.hats.items() if not holder]
        if gaps:
            missing.append(AskMissingHatsFact(project_id=p.id, name=p.name, hats=gaps))
        n = p.decisions.get("overdue", 0)
        if n:
            overdue.append(AskOverdueFact(project_id=p.id, name=p.name, count=n))
        runtime = (p.stack or {}).get("runtime")
        if runtime:
            by_runtime.setdefault(runtime, []).append(p.name)
        closed += p.agent_closed_30d
    return WorkspaceFacts(
        my_open_decisions=mine,
        projects_missing_hats=missing,
        overdue=overdue,
        by_runtime=by_runtime,
        agent_closed_30d=closed,
    )


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def facts_to_text(facts: WorkspaceFacts) -> str:
    lines: list[str] = []
    n = len(facts.my_open_decisions)
    lines.append(
        f"The asker has {_plural(n, 'decision', 'decisions')} waiting."
        if n
        else "The asker has no decisions waiting."
    )
    for d in facts.my_open_decisions:
        due = f", expires {d.expires_at.date().isoformat()}" if d.expires_at else ""
        lines.append(f"Waiting on the asker: {d.kind} in project {d.project_name}{due}.")
    if facts.projects_missing_hats:
        for p in facts.projects_missing_hats:
            hats = " or ".join(h.replace("_", " ") for h in p.hats)
            lines.append(f"Project {p.name} has no {hats}.")
    else:
        lines.append("Every project has all its hats assigned.")
    if facts.overdue:
        for o in facts.overdue:
            lines.append(
                f"Project {o.name} has {_plural(o.count, 'overdue decision', 'overdue decisions')}."
            )
    else:
        lines.append("No decisions are overdue.")
    for runtime, projects in sorted(facts.by_runtime.items()):
        lines.append(f"Projects on {runtime}: {', '.join(projects)}.")
    lines.append(
        f"Agents closed {_plural(facts.agent_closed_30d, 'task', 'tasks')} in the last 30 days."
    )
    return "\n".join(lines)
