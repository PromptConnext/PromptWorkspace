"""The delivery store (plan 0029): changes, decisions and project roles,
against both adapters."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.models.schemas import Decision, DeliveryChange, Task, new_id, utcnow

from . import _helpers as h

pytestmark = pytest.mark.contract


def _change(project, ws, key, ref, position, **extra) -> DeliveryChange:
    return DeliveryChange(
        project_id=project.id,
        workspace_id=ws.id,
        ref=ref,
        key=key,
        title=key.title(),
        kind=extra.pop("kind", "setup"),
        position=position,
        **extra,
    )


def test_changes_round_trip_in_position_order_and_hide_retired(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    later = _change(project, ws, "polish", "C2", 1, kind="polish", depends_on=["setup"])
    first = _change(project, ws, "setup", "C1", 0)
    gone = _change(project, ws, "story:1", "C3", 2, kind="story", story=1, deleted_at=utcnow())

    repo.upsert_delivery_changes(project.id, [later, first, gone])

    live = repo.list_delivery_changes(project.id)
    assert [c.ref for c in live] == ["C1", "C2"]
    assert live[1].depends_on == ["setup"]
    everything = repo.list_delivery_changes(project.id, include_deleted=True)
    assert {c.ref for c in everything} == {"C1", "C2", "C3"}


def test_changes_upsert_replaces_by_id(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    change = _change(project, ws, "setup", "C1", 0)
    repo.upsert_delivery_changes(project.id, [change])

    repo.upsert_delivery_changes(project.id, [change.model_copy(update={"title": "Renamed"})])

    (stored,) = repo.list_delivery_changes(project.id)
    assert stored.id == change.id and stored.title == "Renamed"


def test_decisions_newest_first_and_saved_by_id(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    now = utcnow()
    older = Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval", title="Intent",
        subject_stage="specify", subject_hash="a" * 64, routed_hat="business_owner",
        requested_by=admin, created_at=now - timedelta(minutes=5),
    )
    newer = older.model_copy(update={"id": "00000000-0000-4000-8000-000000000002",
                                     "created_at": now})
    repo.save_decision(older)
    repo.save_decision(newer)

    assert [d.id for d in repo.list_decisions(project.id)] == [newer.id, older.id]
    repo.save_decision(older.model_copy(update={"status": "approved", "resolved_by": admin}))
    fetched = repo.get_decision(project.id, older.id)
    assert fetched is not None and fetched.status == "approved"
    assert repo.get_decision(project.id, "00000000-0000-4000-8000-0000000000ff") is None


def test_project_roles_set_replace_and_clear(repo: Repository) -> None:
    bob = h.new_id()
    ws, admin = h.workspace(repo, members=(bob,))
    project = h.project(repo, ws, admin)

    repo.set_project_role(project.id, ws.id, "tech_steward", admin, admin)
    repo.set_project_role(project.id, ws.id, "tech_steward", bob, admin)
    repo.set_project_role(project.id, ws.id, "business_owner", admin, admin)
    roles = {r.hat: r.user_id for r in repo.list_project_roles(project.id)}
    assert roles == {"tech_steward": bob, "business_owner": admin}

    repo.set_project_role(project.id, ws.id, "business_owner", None, admin)
    assert [r.hat for r in repo.list_project_roles(project.id)] == ["tech_steward"]


def test_task_change_ids_are_the_live_tasks_in_pull_order(repo: Repository) -> None:
    """GET /delivery-plan groups task ids by change from this one narrow read
    instead of a full graph pull (several requests on Supabase). Same rows as
    a bootstrap pull (live tasks only) and the same order, `(updated_at, id)`."""
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    other = h.project(repo, ws, admin)
    setup, story = _change(project, ws, "setup", "C1", 0), _change(project, ws, "story:1", "C2", 1)
    elsewhere = _change(other, ws, "setup", "C1", 0)
    repo.upsert_delivery_changes(project.id, [setup, story])
    repo.upsert_delivery_changes(other.id, [elsewhere])
    change_a, change_b = setup.id, story.id  # pw_tasks.change_id is a foreign key
    first = Task(id=new_id(), project_id=project.id, title="first", change_id=change_a)
    second = Task(id=new_id(), project_id=project.id, title="second", change_id=change_b)
    loose = Task(id=new_id(), project_id=project.id, title="no change")
    gone = Task(id=new_id(), project_id=project.id, title="gone", change_id=change_a)
    for task in (first, second, loose, gone):
        h.push_tasks(repo, project.id, [task])
    h.push_tasks(repo, other.id, [Task(id=new_id(), project_id=other.id, title="x",
                                       change_id=elsewhere.id)])
    h.push_tasks(repo, project.id, [gone.model_copy(update={"deleted_at": utcnow()})])
    # Touching `first` again moves it to the end of the pull order.
    h.push_tasks(repo, project.id, [first.model_copy(update={"title": "first, renamed"})])

    rows = repo.list_task_change_ids(project.id)

    assert rows == [(second.id, change_b), (loose.id, None), (first.id, change_a)]
    assert [t.id for t in repo.get_graph(project.id).tasks] == [row[0] for row in rows]
