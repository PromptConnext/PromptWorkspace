"""The three reads behind the workspace overview (plan 0033), against both adapters."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.delivery.receipts import seal
from app.models.schemas import (
    Artifact,
    ArtifactAgent,
    GenerationRun,
    GraphUpsertRequest,
    ReceiptDraft,
    Task,
    TaskStatus,
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
