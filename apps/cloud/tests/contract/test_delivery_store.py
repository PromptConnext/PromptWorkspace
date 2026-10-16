"""The delivery store (plan 0029): changes, decisions and project roles,
against both adapters."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.models.schemas import Decision, DeliveryChange, Task, TaskStatus, new_id, utcnow

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


def test_decision_keeps_the_document_it_was_asked_about(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    decision = Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval", title="Intent",
        subject_stage="specify", subject_hash="a" * 64, routed_hat="business_owner",
        requested_by=admin, subject_content="# Spec\n\nBook a slot.",
    )
    repo.save_decision(decision)

    (stored,) = repo.list_decisions(project.id)
    assert stored.subject_content == "# Spec\n\nBook a slot."
    fetched = repo.get_decision(project.id, decision.id)
    assert fetched is not None and fetched.subject_content == "# Spec\n\nBook a slot."


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


def test_task_change_status_is_the_live_tasks_in_pull_order(repo: Repository) -> None:
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

    rows = repo.list_task_change_status(project.id)

    assert rows == [
        (second.id, change_b, "todo"),
        (loose.id, None, "todo"),
        (first.id, change_a, "todo"),
    ]
    assert [t.id for t in repo.get_graph(project.id).tasks] == [row[0] for row in rows]

    # A status change moves the task's row (and only its row).
    h.push_tasks(repo, project.id, [second.model_copy(update={"status": TaskStatus.implemented})])
    after = repo.list_task_change_status(project.id)
    assert (second.id, change_b, "implemented") in after
    assert [r for r in after if r[0] != second.id] == [r for r in rows if r[0] != second.id]


def _snap_decision(project, ws, content="# Spec\n\nPatient: Somchai, 081-234-5678"):
    return Decision(
        project_id=project.id, workspace_id=ws.id, kind="intent_approval", title="t",
        subject_stage="specify", subject_hash="h" * 64, subject_content=content,
        routed_hat="business_owner", requested_by="bob",
    )


def test_snapshot_content_round_trips_through_its_own_store(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))

    assert repo.get_decision(project.id, d.id).subject_content.startswith("# Spec")
    assert repo.list_decisions(project.id)[0].subject_content.startswith("# Spec")


def test_resaving_a_decision_does_not_replace_its_snapshot(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))
    repo.save_decision(d.model_copy(update={"status": "approved", "subject_content": "other"}))

    assert repo.get_decision(project.id, d.id).subject_content.startswith("# Spec")


def test_erasing_a_snapshot_keeps_the_decision_and_its_hash(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = repo.save_decision(_snap_decision(project, ws))

    assert repo.erase_decision_snapshot(project.id, d.id, admin) is True
    assert repo.erase_decision_snapshot(project.id, d.id, admin) is False

    stored = repo.get_decision(project.id, d.id)
    assert stored.subject_content is None and stored.subject_hash == "h" * 64
    # A later save of the decision must not bring the content back.
    repo.save_decision(stored.model_copy(update={"status": "approved"}))
    assert repo.get_decision(project.id, d.id).subject_content is None


def test_due_decisions_are_open_ones_expiring_by_the_cutoff(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    now = utcnow()

    def save(status, hours):
        return repo.save_decision(Decision(
            project_id=project.id, workspace_id=ws.id, kind="plan_approval", title="t",
            subject_stage="tasks", subject_hash="h", routed_hat="tech_steward",
            requested_by="bob", status=status, expires_at=now + timedelta(hours=hours)))

    soon, later = save("open", 1), save("open", 100)
    save("approved", 1)

    due = [d.id for d in repo.list_due_decisions(now + timedelta(hours=48))
           if d.project_id == project.id]
    assert due == [soon.id] and later.id not in due


def _open_decision(repo: Repository, project, ws, status="open"):
    return repo.save_decision(Decision(
        project_id=project.id, workspace_id=ws.id, kind="plan_approval", title="t",
        subject_stage="tasks", subject_hash="h", routed_hat="tech_steward",
        requested_by="bob", status=status))


def test_update_open_decision_applies_to_an_open_decision(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = _open_decision(repo, project, ws)
    now = utcnow()

    out = repo.update_open_decision(project.id, d.id, {"reminded_at": now})

    assert out is not None and out.status == "open" and out.reminded_at is not None
    assert repo.get_decision(project.id, d.id).reminded_at is not None


def test_update_open_decision_leaves_a_resolved_decision_alone(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    d = _open_decision(repo, project, ws, status="approved")

    out = repo.update_open_decision(
        project.id, d.id, {"status": "expired", "resolved_at": utcnow()})

    assert out is None
    assert repo.get_decision(project.id, d.id).status == "approved"


def test_update_open_decision_unknown_id_is_none(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    assert repo.update_open_decision(project.id, new_id(), {"reminded_at": utcnow()}) is None
