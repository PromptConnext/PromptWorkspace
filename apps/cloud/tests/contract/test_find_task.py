"""`find_task`: a task read by id alone, for the hosted MCP `get_task` and
`close_task`, which must not scan the caller's assigned tasks to find one."""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import Task, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_find_task_by_id_across_projects(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    first = h.project(repo, ws, admin)
    second = h.project(repo, ws, admin)
    a = Task(project_id=first.id, title="a")
    b = Task(project_id=second.id, title="b")
    h.push_tasks(repo, first.id, [a])
    h.push_tasks(repo, second.id, [b])

    got = repo.find_task(b.id)
    assert got is not None and got.id == b.id and got.project_id == second.id
    assert repo.find_task(new_id()) is None
