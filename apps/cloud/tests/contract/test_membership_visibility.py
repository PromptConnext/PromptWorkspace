"""Membership is the predicate every read above it depends on.

`get_membership` and `list_members` (app/db/repository.py:695,:699;
app/db/supabase_repository.py:261,:273) decide what a caller can see, and the
interface is explicit that an assignment must never substitute for a membership:
"an assignment outlives a membership removal, so a removed member would
otherwise keep reading their old tasks" (app/db/repository.py:201-203). These
cases assert that removal takes effect on the next read, on both adapters, with
the stale `assigned_user_id` deliberately left on the row.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import Role, Task, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_removed_member_stops_seeing_projects_and_their_assigned_tasks(repo: Repository) -> None:
    member = new_id()
    ws, admin = h.workspace(repo, members=(member,))
    proj = h.project(repo, ws, admin)
    task = Task(project_id=proj.id, title="Ship the thing", assigned_user_id=member)
    h.push_tasks(repo, proj.id, [task])

    # While the membership stands, all four reads agree the member is inside.
    assert repo.get_membership(ws.id, member) == Role.member
    assert member in {m.user_id for m in repo.list_members(ws.id)}
    assert proj.id in {p.id for p in repo.list_projects(member)}
    assert ws.id in {w.id for w in repo.list_workspaces(member)}
    assert h.assigned_ids(repo, member) == [task.id]

    repo.remove_member(ws.id, member)

    assert repo.get_membership(ws.id, member) is None
    assert member not in {m.user_id for m in repo.list_members(ws.id)}
    assert proj.id not in {p.id for p in repo.list_projects(member)}
    assert ws.id not in {w.id for w in repo.list_workspaces(member)}
    # The point of the case: the row still names them, and that must not be
    # what grants access.
    assert h.assigned_ids(repo, member) == []
    assert h.assigned_ids(repo, member, workspace_id=ws.id) == []
    stored = repo.get_task(proj.id, task.id)
    assert stored is not None
    assert stored.assigned_user_id == member


def test_membership_in_one_workspace_does_not_leak_another(repo: Repository) -> None:
    """A stale assignment in a workspace the caller never joined is invisible
    even while they hold a live membership somewhere else."""
    member = new_id()
    joined, joined_admin = h.workspace(repo, members=(member,))
    foreign, foreign_admin = h.workspace(repo)  # member is deliberately not added

    mine = h.project(repo, joined, joined_admin)
    theirs = h.project(repo, foreign, foreign_admin)
    my_task = Task(project_id=mine.id, title="Mine", assigned_user_id=member)
    their_task = Task(project_id=theirs.id, title="Theirs", assigned_user_id=member)
    h.push_tasks(repo, mine.id, [my_task])
    h.push_tasks(repo, theirs.id, [their_task])

    assert repo.get_membership(foreign.id, member) is None
    assert h.assigned_ids(repo, member) == [my_task.id]
    assert h.assigned_ids(repo, member, workspace_id=foreign.id) == []
    assert theirs.id not in {p.id for p in repo.list_projects(member)}
