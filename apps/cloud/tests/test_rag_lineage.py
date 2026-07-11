"""Unit tests (M10) for the classifier and graph-walk lineage resolver — no
HTTP, no fixtures beyond a hand-built ProjectGraph. Fast, deterministic."""

from __future__ import annotations

from app.models.schemas import (
    AgentRun,
    Artifact,
    Project,
    ProjectGraph,
    Requirement,
    SpecDocument,
    Task,
)
from app.rag.classify import classify_question
from app.rag.lineage import compute_facts, resolve_target


def test_classify_lineage_question():
    assert classify_question("Is the payments requirement done?") == "lineage"
    assert classify_question("How many tasks are open?") == "lineage"


def test_classify_content_question():
    assert classify_question("Why did we choose this approach?") == "content"
    assert classify_question("Explain the acceptance criteria for login") == "content"


def test_classify_mixed_question():
    assert classify_question("What is the status and why did we design it this way?") == "mixed"


def test_classify_defaults_to_content_when_unrecognized():
    assert classify_question("Tell me a story") == "content"


def _graph() -> ProjectGraph:
    project = Project(id="p1", name="Rocket", workspace_id="w1", owner_id="alice")
    req = Requirement(id="r1", project_id="p1", title="Payments requirement", status="approved")
    spec = SpecDocument(id="s1", project_id="p1", requirement_id="r1", content="spec")
    tasks = [
        Task(
            id="t1", project_id="p1", spec_id="s1", title="Build login form", status="implemented"
        ),
        Task(id="t2", project_id="p1", spec_id="s1", title="Wire up SSO", status="todo"),
        Task(id="t3", project_id="p1", spec_id="s1", title="Charge card", status="verified"),
    ]
    artifacts = [Artifact(id="a1", project_id="p1", task_id="t1", uri="src/login.ts")]
    agent_runs = [AgentRun(id="g1", project_id="p1", task_id="t1", status="succeeded")]
    return ProjectGraph(
        project=project,
        requirements=[req],
        spec_documents=[spec],
        tasks=tasks,
        artifacts=artifacts,
        agent_runs=agent_runs,
    )


def test_resolve_target_matches_requirement_by_title():
    graph = _graph()
    target = resolve_target(graph, "Is the payments requirement done?")
    assert target is not None
    assert target.kind == "requirement"
    assert target.node.id == "r1"


def test_resolve_target_matches_task_by_title():
    graph = _graph()
    target = resolve_target(graph, "What artifacts back the login form task?")
    assert target is not None
    assert target.kind == "task"
    assert target.node.id == "t1"


def test_resolve_target_none_when_no_overlap():
    graph = _graph()
    assert resolve_target(graph, "zzz qqq unrelated") is None


def test_compute_facts_requirement_scope_is_exact():
    graph = _graph()
    target = resolve_target(graph, "Is the payments requirement done?")
    facts = compute_facts(graph, target)

    assert facts.scope == "requirement"
    assert facts.node_id == "r1"
    assert facts.tasks_total == 3
    assert facts.tasks_done == 2  # t1 implemented, t3 verified
    assert facts.task_status_counts == {"implemented": 1, "todo": 1, "verified": 1}


def test_compute_facts_task_scope_includes_artifacts_and_runs():
    graph = _graph()
    target = resolve_target(graph, "What artifacts back the login form task?")
    facts = compute_facts(graph, target)

    assert facts.scope == "task"
    assert facts.node_id == "t1"
    assert facts.artifacts_total == 1
    assert len(facts.agent_runs) == 1
    assert facts.agent_runs[0].id == "g1"
    assert facts.agent_runs[0].status == "succeeded"


def test_compute_facts_project_scope_when_unresolved():
    graph = _graph()
    facts = compute_facts(graph, None)

    assert facts.scope == "project"
    assert facts.tasks_total == 3
    assert facts.tasks_done == 2
