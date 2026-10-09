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
from pydantic import BaseModel

from app.api._guards import member_role
from app.api.delivery import DecisionBase, _routing_context
from app.db.repository import Repository
from app.delivery.decisions import can_resolve
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import AssignedTask, Role, TaskStatus, WorkspaceMember

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


class InboxItem(BaseModel):
    decision: DecisionBase
    project_id: str
    project_name: str
    workspace_id: str
    workspace_name: str


@router.get("/decisions", response_model=list[InboxItem])
def list_my_decisions(
    workspace_id: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[InboxItem]:
    """Open decisions routed to the caller (plan 0029 Decision Inbox). One pass
    over the caller's workspaces and projects: fine at today's scale; move to a
    single indexed query (idx_pw_decisions_open) when it isn't."""
    items: list[InboxItem] = []
    for workspace in repo.list_workspaces(user.id):
        if workspace_id is not None and workspace.id != workspace_id:
            continue
        # Read once per workspace, and only for one with an open decision.
        members: list[WorkspaceMember] | None = None
        role: Role | None = None
        for project in repo.list_projects_by_workspace(workspace.id):
            decisions = [d for d in repo.list_decisions(project.id) if d.status == "open"]
            if not decisions:
                continue
            if members is None:
                members = repo.list_members(workspace.id)
                role = member_role(repo, workspace.id, members, user.id)
            if role is None:
                break  # left the workspace while this request ran
            roles, member_ids, is_admin = _routing_context(repo, project, role, members)
            for decision in decisions:
                if can_resolve(decision, user.id, roles, member_ids, is_admin):
                    items.append(
                        InboxItem(
                            # Not DecisionOut: the inbox lists open decisions and
                            # needs neither the document text nor is_current
                            # (two stage-document reads per project).
                            decision=DecisionBase(
                                **decision.model_dump(exclude={"subject_content"}),
                                can_resolve=True,
                            ),
                            project_id=project.id,
                            project_name=project.name,
                            workspace_id=workspace.id,
                            workspace_name=workspace.name,
                        )
                    )
    items.sort(key=lambda i: i.decision.created_at, reverse=True)
    return items
