"""The three reads behind the workspace overview (plan 0033), against both adapters."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.delivery.receipts import seal
from app.models.schemas import (
    Artifact,
    ArtifactAgent,
    Decision,
    GenerationRun,
    GraphUpsertRequest,
    PolicyScope,
    ReceiptDraft,
    RepoAnalysis,
    RepoSnapshot,
    Task,
    TaskStatus,
    WorkspaceGovernance,
    new_id,
    utcnow,
)

from . import _helpers as h

pytestmark = pytest.mark.contract


def _task(project_id: str, **kw) -> Task:
    return Task(id=new_id(), project_id=project_id, title="t", **kw)


def _artifact(project_id: str, task_id: str, agent: ArtifactAgent | None) -> Artifact:
    return Artifact(
        id=new_id(), project_id=project_id, task_id=task_id, uri="https://x/y", agent=agent
    )


def test_list_tasks_summary_counts_and_agent_flag(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2 = h.project(repo, ws, admin), h.project(repo, ws, admin)
    t1 = _task(p1.id, status=TaskStatus.implemented, assigned_user_id="u-1")
    t2 = _task(p1.id)
    t3 = _task(p2.id, status=TaskStatus.verified)
    repo.upsert_graph(
        p1.id,
        GraphUpsertRequest(
            tasks=[t1, t2],
            artifacts=[_artifact(p1.id, t1.id, ArtifactAgent(client="claude-code", model="m"))],
        ),
        source="pz",
    )
    repo.upsert_graph(
        p2.id,
        GraphUpsertRequest(tasks=[t3], artifacts=[_artifact(p2.id, t3.id, None)]),
        source="pz",
    )

    rows = {r.task_id: r for r in repo.list_tasks_summary([p1.id, p2.id])}

    assert set(rows) == {t1.id, t2.id, t3.id}
    assert [tid for tid, r in rows.items() if r.agent_closed] == [t1.id]
    assert rows[t1.id].assigned_user_id == "u-1" and rows[t1.id].project_id == p1.id
    assert rows[t3.id].status == TaskStatus.verified
    assert repo.list_tasks_summary([]) == []


def test_list_tasks_summary_skips_tombstoned(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p = h.project(repo, ws, admin)
    live, gone = _task(p.id), _task(p.id)
    h.push_tasks(repo, p.id, [live, gone])
    h.push_tasks(repo, p.id, [gone.model_copy(update={"deleted_at": utcnow()})])

    assert [r.task_id for r in repo.list_tasks_summary([p.id])] == [live.id]


def test_latest_receipt_at_only_for_projects_with_receipts(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2 = h.project(repo, ws, admin), h.project(repo, ws, admin)

    def draft() -> ReceiptDraft:
        return ReceiptDraft(
            project_id=p1.id, workspace_id=ws.id, event="decision.requested",
            subject_type="decision", subject_id=new_id(), actor="alice", body={},
        )

    first = repo.insert_receipt(seal(draft(), None))
    second = repo.insert_receipt(seal(draft(), first))

    latest = repo.latest_receipt_at([p1.id, p2.id])

    assert set(latest) == {p1.id}
    assert latest[p1.id] == second.created_at
    assert repo.latest_receipt_at([]) == {}


def test_list_generation_runs_since_newest_first(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    other_ws, other_admin = h.workspace(repo)
    p = h.project(repo, ws, admin)
    op = h.project(repo, other_ws, other_admin)
    now = utcnow()

    def run(project, workspace, age_h: int) -> GenerationRun:
        return repo.create_generation_run(
            GenerationRun(
                workspace_id=workspace.id, project_id=project.id, stage="plan", model="m",
                created_at=now - timedelta(hours=age_h),
            )
        )

    old, mid, new = run(p, ws, 48), run(p, ws, 5), run(p, ws, 1)
    run(op, other_ws, 1)

    got = repo.list_generation_runs(ws.id, now - timedelta(hours=24))

    assert [r.id for r in got] == [new.id, mid.id]
    assert old.id not in {r.id for r in got}


def test_get_workspace_governance_none_when_absent(repo: Repository) -> None:
    ws, _admin = h.workspace(repo)
    assert repo.get_workspace_governance(ws.id) is None


def test_put_workspace_governance_round_trips(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    g = WorkspaceGovernance(
        workspace_id=ws.id,
        policy_scope=PolicyScope(selected=["gdpr"], custom_text="x"),
        required_hats=["tech_steward"],
        require_seeded_rules=False,
        updated_by=admin,
    )
    put = repo.put_workspace_governance(g)
    assert repo.get_workspace_governance(ws.id) == put
    replaced = repo.put_workspace_governance(g.model_copy(update={"require_seeded_rules": True}))
    assert repo.get_workspace_governance(ws.id) == replaced
    assert replaced.require_seeded_rules is True


def _decision(project_id: str, workspace_id: str, age_h: int) -> Decision:
    return Decision(
        project_id=project_id, workspace_id=workspace_id, kind="plan_approval", title="t",
        subject_stage="tasks", subject_hash="h", routed_hat="business_owner",
        requested_by="alice", created_at=utcnow() - timedelta(hours=age_h),
    )


def test_list_project_roles_for_groups_by_project(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2, p3 = (h.project(repo, ws, admin) for _ in range(3))
    repo.set_project_role(p1.id, ws.id, "tech_steward", "u-1", admin)
    repo.set_project_role(p1.id, ws.id, "business_owner", "u-2", admin)
    repo.set_project_role(p2.id, ws.id, "business_owner", "u-3", admin)

    got = repo.list_project_roles_for([p1.id, p2.id, p3.id])

    assert set(got) == {p1.id, p2.id, p3.id}
    assert [r.hat for r in got[p1.id]] == ["business_owner", "tech_steward"]
    assert [r.user_id for r in got[p2.id]] == ["u-3"]
    assert got[p3.id] == []
    assert got[p1.id] == repo.list_project_roles(p1.id)
    assert repo.list_project_roles_for([]) == {}


def test_list_decisions_for_newest_first_per_project(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2, p3 = (h.project(repo, ws, admin) for _ in range(3))
    old, new = _decision(p1.id, ws.id, 5), _decision(p1.id, ws.id, 1)
    other = _decision(p2.id, ws.id, 2)
    for d in (old, new, other):
        repo.save_decision(d)

    got = repo.list_decisions_for([p1.id, p2.id, p3.id])

    assert set(got) == {p1.id, p2.id, p3.id}
    assert [d.id for d in got[p1.id]] == [new.id, old.id]
    assert [d.id for d in got[p2.id]] == [other.id]
    assert got[p3.id] == []
    assert [d.id for d in repo.list_decisions(p1.id)] == [new.id, old.id]
    assert repo.list_decisions_for([]) == {}


def test_get_repo_analyses_only_present(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2 = h.project(repo, ws, admin), h.project(repo, ws, admin)
    repo.upsert_repo_analysis(
        RepoAnalysis(
            project_id=p1.id, workspace_id=ws.id, commit_sha="a" * 40,
            snapshot=RepoSnapshot(commit_sha="a" * 40, default_branch="main", file_count=0),
            created_by=admin,
        )
    )

    got = repo.get_repo_analyses([p1.id, p2.id])

    assert set(got) == {p1.id}
    assert got[p1.id].commit_sha == "a" * 40
    assert repo.get_repo_analyses([]) == {}


def test_latest_receipt_at_matches_per_project_max(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    p1, p2 = h.project(repo, ws, admin), h.project(repo, ws, admin)

    def draft(pid: str) -> ReceiptDraft:
        return ReceiptDraft(
            project_id=pid, workspace_id=ws.id, event="decision.requested",
            subject_type="decision", subject_id=new_id(), actor="alice", body={},
        )

    a1 = repo.insert_receipt(seal(draft(p1.id), None))
    a2 = repo.insert_receipt(seal(draft(p1.id), a1))
    b1 = repo.insert_receipt(seal(draft(p2.id), None))

    latest = repo.latest_receipt_at([p1.id, p2.id])

    assert latest == {p1.id: max(a1.created_at, a2.created_at), p2.id: b1.created_at}
