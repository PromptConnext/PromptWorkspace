"""Shared setup for the contract cases.

Every id is a fresh uuid, which is what lets the cases share a long-lived
database without cleaning up after each other — and what makes ids usable as
the deterministic sort key the assertions compare against. Nothing here touches
an adapter's internals: it is all `Repository` calls the production routers make
too.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.models.schemas import (
    GraphUpsertRequest,
    Project,
    Requirement,
    Role,
    Task,
    Workspace,
    new_id,
)


def workspace(repo: Repository, *, members: tuple[str, ...] = ()) -> tuple[Workspace, str]:
    """A workspace plus its admin's user id. `members` join as `Role.member`."""
    admin = new_id()
    ws = repo.create_workspace(f"contract-{new_id()[:8]}", admin)
    for user_id in members:
        repo.add_member(ws.id, user_id, Role.member)
    return ws, admin


def project(repo: Repository, ws: Workspace, admin: str, name: str | None = None) -> Project:
    return repo.create_project(ws.id, admin, name or f"project-{new_id()[:8]}")


def push_tasks(repo: Repository, project_id: str, tasks: list[Task], source: str = "pz") -> None:
    repo.upsert_graph(
        project_id, GraphUpsertRequest(tasks=tasks, source=source), source=source
    )


def push_requirements(
    repo: Repository, project_id: str, requirements: list[Requirement], source: str = "pz"
) -> None:
    repo.upsert_graph(
        project_id,
        GraphUpsertRequest(requirements=requirements, source=source),
        source=source,
    )


def assigned_ids(repo: Repository, user_id: str, **kwargs) -> list[str]:
    return [row.task.id for row in repo.list_assigned_tasks(user_id, **kwargs)]
