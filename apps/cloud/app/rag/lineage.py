"""Graph-walk answers for lineage/status questions (M10).

Pure traversal over `ProjectGraph` — the same exact, SQL-backed snapshot
`reindex_project` already pulls via `repo.get_graph()`. No embeddings, no
similarity search: this is the "graph-exact" half of M10's hybrid retrieval.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from app.models.schemas import LineageAgentRun, LineageFacts, ProjectGraph, Requirement, Task

# A task counts as "done" here using the same convention the web app already
# uses (apps/web/src/components/project/ProgressRollup.tsx's DONE list), so
# the assistant and the UI agree on what "done" means.
DONE_STATUSES = {"implemented", "verified"}

_STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "to", "of", "in", "on", "for", "and", "or", "with", "this", "that",
    "it", "its", "do", "does", "did", "has", "have", "had",
    "what", "which", "who", "how", "why",
}

_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD_RE.findall(text.lower()) if len(w) >= 2 and w not in _STOPWORDS}


@dataclass(frozen=True)
class ResolvedTarget:
    kind: Literal["requirement", "task"]
    node: Requirement | Task


def resolve_target(graph: ProjectGraph, question: str) -> ResolvedTarget | None:
    """Best-matching requirement or task by token overlap with the question.
    Ties (and a requirement/task score tie) prefer the requirement — a status
    question defaults to the requirement-level rollup unless a task is the
    clearer match."""
    qtokens = _tokens(question)
    if not qtokens:
        return None

    def best(nodes, kind: Literal["requirement", "task"]) -> tuple[int, ResolvedTarget | None]:
        best_score = 0
        best_node = None
        for node in nodes:
            score = len(qtokens & _tokens(node.title))
            if score > best_score:
                best_score, best_node = score, node
        return best_score, (ResolvedTarget(kind, best_node) if best_node else None)

    req_score, req_target = best(graph.requirements, "requirement")
    task_score, task_target = best(graph.tasks, "task")

    if req_score == 0 and task_score == 0:
        return None
    if req_score >= task_score:
        return req_target
    return task_target


def compute_facts(graph: ProjectGraph, target: ResolvedTarget | None) -> LineageFacts:
    if target is None:
        return _project_facts(graph)
    if target.kind == "requirement":
        return _requirement_facts(graph, target.node)
    return _task_facts(graph, target.node)


def _project_facts(graph: ProjectGraph) -> LineageFacts:
    tasks = graph.tasks
    return LineageFacts(
        scope="project",
        title=graph.project.name,
        specs_total=len(graph.spec_documents),
        tasks_total=len(tasks),
        tasks_done=sum(1 for t in tasks if t.status in DONE_STATUSES),
        task_status_counts=_status_counts(tasks),
        artifacts_total=len(graph.artifacts),
    )


def _requirement_facts(graph: ProjectGraph, requirement: Requirement) -> LineageFacts:
    spec_ids = {s.id for s in graph.spec_documents if s.requirement_id == requirement.id}
    tasks = [t for t in graph.tasks if t.spec_id in spec_ids]
    task_ids = {t.id for t in tasks}
    artifacts = [a for a in graph.artifacts if a.task_id in task_ids]
    return LineageFacts(
        scope="requirement",
        node_type="requirements",
        node_id=requirement.id,
        title=requirement.title,
        status=requirement.status,
        specs_total=len(spec_ids),
        tasks_total=len(tasks),
        tasks_done=sum(1 for t in tasks if t.status in DONE_STATUSES),
        task_status_counts=_status_counts(tasks),
        artifacts_total=len(artifacts),
    )


def _task_facts(graph: ProjectGraph, task: Task) -> LineageFacts:
    artifacts = [a for a in graph.artifacts if a.task_id == task.id]
    agent_runs = [
        LineageAgentRun(id=ar.id, status=ar.status)
        for ar in graph.agent_runs
        if ar.task_id == task.id
    ]
    return LineageFacts(
        scope="task",
        node_type="tasks",
        node_id=task.id,
        title=task.title,
        status=task.status,
        specs_total=1 if task.spec_id else 0,
        tasks_total=1,
        tasks_done=1 if task.status in DONE_STATUSES else 0,
        task_status_counts={task.status: 1},
        artifacts_total=len(artifacts),
        agent_runs=agent_runs,
    )


def _status_counts(tasks: list[Task]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in tasks:
        counts[t.status] = counts.get(t.status, 0) + 1
    return counts


def facts_to_text(facts: LineageFacts) -> str:
    """Render exact facts as text for the model to narrate — the model never
    computes these numbers itself, only reads them."""
    lines = [f"{facts.scope.upper()}: {facts.title}"]
    if facts.status is not None:
        lines.append(f"status: {facts.status}")
    if facts.specs_total:
        lines.append(f"specs: {facts.specs_total}")
    lines.append(f"tasks: {facts.tasks_done}/{facts.tasks_total} done")
    if facts.task_status_counts:
        breakdown = ", ".join(f"{k}={v}" for k, v in facts.task_status_counts.items())
        lines.append(f"task status breakdown: {breakdown}")
    lines.append(f"artifacts: {facts.artifacts_total}")
    if facts.agent_runs:
        runs = ", ".join(f"{r.id}={r.status}" for r in facts.agent_runs)
        lines.append(f"agent runs: {runs}")
    return "\n".join(lines)
