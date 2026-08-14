"""Identity-scoped reads — "what is assigned to me", across every workspace.

Separate from sync.py deliberately: that module is the graph transport, keyed
by project. This one is keyed by the caller. It exists because a task client
(ADR 0019's VS Code extension) otherwise has to walk `GET /workspaces` ->
`GET /workspaces/{id}/projects` -> `GET /sync/projects/{id}/graph` on every
activation and filter `assigned_user_id` itself — one request per project, and
a dependency on graph pagination for a question that is not about the graph.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import AssignedTask, TaskStatus

router = APIRouter(prefix="/me", tags=["me"])

# What a task list means without an explicit filter: work still to do. A client
# asks for all four states explicitly when it wants to show completed tasks.
_OPEN_STATUSES = [TaskStatus.todo, TaskStatus.in_progress]


@router.get("/tasks", response_model=list[AssignedTask])
def list_my_tasks(
    workspace_id: str | None = Query(default=None),
    status: list[TaskStatus] | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[AssignedTask]:
    return repo.list_assigned_tasks(
        user.id,
        workspace_id=workspace_id,
        statuses=status or _OPEN_STATUSES,
        limit=limit,
    )
