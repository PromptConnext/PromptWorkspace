"""An entity id belongs to exactly one project, on either adapter.

Graph entity ids are client-supplied, so "the row for this id" and "a row in
this project" are two different lookups — and the adapters used to disagree
about which one an upsert performs. `SupabaseRepository.upsert_graph` read the
stored row by `id` alone and then wrote `project_id` from the request, so a push
into project B that named project A's task id took A's row, merged into it as an
*update*, and relocated it: title, status, assignee and acceptance criteria
overwritten, the row gone from A's graph. `InMemoryRepository` keyed its store by
project, so the same push created a second, unrelated row and every test in the
suite saw the harmless version of the bug.

Both now refuse the write outright (`CrossProjectWrite`), before anything lands.
The cases below state that as a contract rather than as an adapter detail, since
neither behaviour was expressible against a single implementation.
"""

from __future__ import annotations

import pytest

from app.db.repository import CrossProjectWrite, Repository
from app.models.schemas import (
    AcceptanceCriterion,
    GraphUpsertRequest,
    Requirement,
    Task,
    TaskStatus,
    new_id,
)

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_a_push_cannot_take_another_projects_task(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project_a = h.project(repo, ws, admin)
    project_b = h.project(repo, ws, admin)

    task_id = new_id()
    h.push_tasks(
        repo,
        project_a.id,
        [
            Task(
                id=task_id,
                project_id=project_a.id,
                title="Add a retry",
                status=TaskStatus.implemented,
                acceptance_criteria=[AcceptanceCriterion(text="Retries twice")],
                assigned_user_id=admin,
            )
        ],
    )

    with pytest.raises(CrossProjectWrite):
        h.push_tasks(
            repo,
            project_b.id,
            [Task(id=task_id, project_id=project_b.id, title="Mine now")],
        )

    # A's row is untouched — not relocated, not reset, not tombstoned.
    stored = repo.get_task(project_a.id, task_id)
    assert stored is not None
    assert stored.title == "Add a retry"
    assert stored.status == TaskStatus.implemented
    assert [c.text for c in stored.acceptance_criteria] == ["Retries twice"]
    assert stored.assigned_user_id == admin
    # And B gained nothing, under that id or any other.
    assert repo.get_task(project_b.id, task_id) is None
    assert repo.get_graph(project_b.id).tasks == []


def test_the_refusal_covers_every_entity_type(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project_a = h.project(repo, ws, admin)
    project_b = h.project(repo, ws, admin)

    requirement_id = new_id()
    h.push_requirements(
        repo,
        project_a.id,
        [Requirement(id=requirement_id, project_id=project_a.id, title="Log in")],
    )

    with pytest.raises(CrossProjectWrite):
        h.push_requirements(
            repo,
            project_b.id,
            [Requirement(id=requirement_id, project_id=project_b.id, title="Mine now")],
        )

    assert repo.get_graph(project_a.id).requirements[0].title == "Log in"
    assert repo.get_graph(project_b.id).requirements == []


def test_nothing_in_a_refused_push_lands(repo: Repository) -> None:
    """The refusal is raised before the first write, not part-way through: a
    push that smuggles one foreign id alongside legitimate rows writes none of
    them."""
    ws, admin = h.workspace(repo)
    project_a = h.project(repo, ws, admin)
    project_b = h.project(repo, ws, admin)

    stolen_id = new_id()
    h.push_tasks(
        repo, project_a.id, [Task(id=stolen_id, project_id=project_a.id, title="Theirs")]
    )

    own_requirement = new_id()
    own_task = new_id()
    with pytest.raises(CrossProjectWrite):
        repo.upsert_graph(
            project_b.id,
            GraphUpsertRequest(
                requirements=[
                    Requirement(id=own_requirement, project_id=project_b.id, title="Mine")
                ],
                tasks=[
                    Task(id=own_task, project_id=project_b.id, title="Mine"),
                    Task(id=stolen_id, project_id=project_b.id, title="Theirs, taken"),
                ],
            ),
            source="pz",
        )

    graph = repo.get_graph(project_b.id)
    assert graph.requirements == []
    assert graph.tasks == []


def test_the_same_id_in_its_own_project_still_updates(repo: Repository) -> None:
    """The guard is about *foreign* ids; an ordinary second push of a row the
    project already holds is the normal update path."""
    ws, admin = h.workspace(repo)
    proj = h.project(repo, ws, admin)

    task_id = new_id()
    h.push_tasks(repo, proj.id, [Task(id=task_id, project_id=proj.id, title="First")])
    h.push_tasks(repo, proj.id, [Task(id=task_id, project_id=proj.id, title="Second")])

    stored = repo.get_task(proj.id, task_id)
    assert stored is not None and stored.title == "Second"
