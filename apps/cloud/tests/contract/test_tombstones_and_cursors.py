"""Tombstones and cursors decide what a client believes about deletions.

`get_graph`'s two modes, `changes_head` (app/db/repository.py:1024;
app/db/supabase_repository.py:693) and `purge_expired_tombstones`
(app/db/repository.py:1145; app/db/supabase_repository.py:881) together answer
one question for a task client: "is what I hold still the whole truth?" The
three cases here are the three ways that answer goes wrong — a delete a client
never learns about, a cheap probe that disagrees with the pull it is supposed to
predict, and garbage collection that rewinds a cursor a client has already
passed.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.models.schemas import Requirement, Task, new_id, utcnow

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_a_tombstone_is_hidden_from_a_bootstrap_pull_and_present_in_an_incremental_one(
    repo: Repository,
) -> None:
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    doomed_id, keeper_id = new_id(), new_id()
    h.push_tasks(
        repo,
        proj.id,
        [
            Task(id=doomed_id, project_id=proj.id, title="doomed"),
            Task(id=keeper_id, project_id=proj.id, title="keeper"),
        ],
    )
    # The cursor a client would hold having pulled both rows while they lived.
    pulled_at = repo.get_graph(proj.id).cursor
    assert pulled_at is not None

    h.push_tasks(
        repo,
        proj.id,
        [Task(id=doomed_id, project_id=proj.id, title="doomed", deleted_at=utcnow())],
    )

    bootstrap = repo.get_graph(proj.id)
    assert {task.id for task in bootstrap.tasks} == {keeper_id}

    incremental = repo.get_graph(proj.id, since=pulled_at)
    by_id = {task.id: task for task in incremental.tasks}
    assert doomed_id in by_id, "a client that pulled before the delete never learns of it"
    assert by_id[doomed_id].deleted_at is not None


def test_changes_head_agrees_with_a_full_pull_for_the_same_since(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)

    first_req = Requirement(project_id=proj.id, title="R1")
    h.push_requirements(repo, proj.id, [first_req])
    first_task = Task(project_id=proj.id, title="T1")
    h.push_tasks(repo, proj.id, [first_task])
    mid = repo.get_graph(proj.id).cursor
    assert mid is not None

    second_req = Requirement(project_id=proj.id, title="R2")
    h.push_requirements(repo, proj.id, [second_req])
    second_task = Task(project_id=proj.id, title="T2")
    h.push_tasks(repo, proj.id, [second_task])

    # Bootstrap: the probe's counts are the pull's row counts, its cursor the
    # pull's cursor. A client uses the first to decide whether to pull at all.
    head_cursor, counts = repo.changes_head(proj.id)
    graph = repo.get_graph(proj.id)
    assert counts == {"requirements": 2, "tasks": 2}
    assert head_cursor == graph.cursor

    # Incremental from the midpoint: exactly the two rows written after it.
    head_cursor, counts = repo.changes_head(proj.id, since=mid)
    graph = repo.get_graph(proj.id, since=mid)
    assert counts == {"requirements": 1, "tasks": 1}
    assert {row.id for row in graph.requirements} == {second_req.id}
    assert {row.id for row in graph.tasks} == {second_task.id}
    assert head_cursor == graph.cursor

    # Drained: nothing newer than the head, and the probe says so rather than
    # reporting a count the pull cannot produce.
    head_cursor, counts = repo.changes_head(proj.id, since=graph.cursor)
    assert counts == {}
    drained = repo.get_graph(proj.id, since=graph.cursor)
    assert drained.requirements == [] and drained.tasks == []


def test_purging_an_expired_tombstone_never_moves_the_cursor_backwards(
    repo: Repository,
) -> None:
    epoch = utcnow() - timedelta(minutes=1)
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)
    doomed_id, keeper_id = new_id(), new_id()
    h.push_tasks(
        repo,
        proj.id,
        [
            Task(id=doomed_id, project_id=proj.id, title="doomed"),
            Task(id=keeper_id, project_id=proj.id, title="keeper"),
        ],
    )
    # Tombstoned long enough ago to be past any sane TTL.
    h.push_tasks(
        repo,
        proj.id,
        [
            Task(
                id=doomed_id,
                project_id=proj.id,
                title="doomed",
                deleted_at=utcnow() - timedelta(days=30),
            )
        ],
    )
    # Then touch the live row, so the head cursor belongs to a row the purge
    # cannot remove. Ordering matters: a purge that deletes the newest row in
    # the project rewinds the cursor by construction, on either adapter, and
    # that is a GC-scheduling question rather than an adapter contract.
    h.push_tasks(repo, proj.id, [Task(id=keeper_id, project_id=proj.id, title="keeper v2")])

    before_cursor, before_counts = repo.changes_head(proj.id)
    assert before_counts == {"tasks": 1}  # the tombstone is not a live row

    purged = repo.purge_expired_tombstones(ttl_days=1)
    assert purged.get("tasks", 0) >= 1

    after_cursor, after_counts = repo.changes_head(proj.id)
    assert after_cursor == before_cursor
    assert after_counts == before_counts

    # And the purged row is gone from an incremental pull rather than
    # reappearing as a live row: a client that has not yet pulled the delete
    # simply never sees the id again.
    incremental = repo.get_graph(proj.id, since=epoch)
    assert {task.id for task in incremental.tasks} == {keeper_id}
