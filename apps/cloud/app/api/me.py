"""Identity-scoped reads — "what is assigned to me", across every workspace.

Separate from sync.py deliberately: that module is the graph transport, keyed
by project. This one is keyed by the caller. It exists because a task client
(ADR 0019's VS Code extension) otherwise has to walk `GET /workspaces` ->
`GET /workspaces/{id}/projects` -> `GET /sync/projects/{id}/graph` on every
activation and filter `assigned_user_id` itself — one request per project, and
a dependency on graph pagination for a question that is not about the graph.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel

from app.api._guards import member_role
from app.api.delivery import DecisionBase, _routing_context
from app.db.repository import Repository
from app.delivery.decisions import can_resolve, is_overdue, latest_decision
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    AssignedTask,
    OAuthGrantOut,
    Role,
    TaskStatus,
    WorkspaceMember,
    utcnow,
)
from app.oauth.known_clients import classify

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
    return assigned_tasks_for(repo, user, workspace_id=workspace_id, statuses=status, limit=limit)


def assigned_tasks_for(
    repo: Repository,
    user: User,
    *,
    workspace_id: str | None = None,
    statuses: list[TaskStatus] | None = None,
    limit: int = 200,
) -> list[AssignedTask]:
    """The caller's assigned tasks, shared by `GET /me/tasks` and the hosted
    MCP `list_my_tasks`/`get_task`/`close_task` tools.

    Membership is re-checked here, per workspace, on top of whatever the
    adapter does: the MCP tools read through the service-role repository,
    where no RLS scopes the read, and an assignment outlives a membership
    removal. A user who left a workspace must stop seeing its tasks at once.
    """
    entries = repo.list_assigned_tasks(
        user.id,
        workspace_id=workspace_id,
        statuses=statuses or _OPEN_STATUSES,
        limit=limit,
    )
    member_of: dict[str, bool] = {}
    out: list[AssignedTask] = []
    for entry in entries:
        ws = entry.workspace_id
        if ws not in member_of:
            member_of[ws] = repo.get_membership(ws, user.id) is not None
        if member_of[ws]:
            out.append(entry)
    return out


class InboxItem(BaseModel):
    decision: DecisionBase
    project_id: str
    project_name: str
    workspace_id: str
    workspace_name: str
    # Who sent a request back; only set for the caller's own sent-back items.
    resolver_email: str | None = None


@router.get("/decisions", response_model=list[InboxItem])
def list_my_decisions(
    workspace_id: str | None = Query(default=None),
    include_mine: bool = Query(default=False),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[InboxItem]:
    return collect_my_decisions(repo, user, workspace_id, include_mine)


def collect_my_decisions(
    repo: Repository, user: User, workspace_id: str | None = None, include_mine: bool = False
) -> list[InboxItem]:
    """Open decisions routed to the caller (plan 0029 Decision Inbox). One pass
    over the caller's workspaces and projects: fine at today's scale; move to a
    single indexed query (idx_pw_decisions_open) when it isn't. With
    `include_mine`, also the caller's own requests that were sent back for
    changes and not asked for again since."""
    items: list[InboxItem] = []
    for workspace in repo.list_workspaces(user.id):
        if workspace_id is not None and workspace.id != workspace_id:
            continue
        # Read once per workspace, and only for one with an open decision.
        members: list[WorkspaceMember] | None = None
        role: Role | None = None
        for project in repo.list_projects_by_workspace(workspace.id):
            now = utcnow()
            all_decisions = repo.list_decisions(project.id)
            decisions = [d for d in all_decisions
                         if d.status == "open" and not is_overdue(d, now)]
            if include_mine:
                for d in all_decisions:
                    if (d.status == "rejected" and d.requested_by == user.id
                            and latest_decision(all_decisions, d.kind) is d):
                        if members is None:
                            members = repo.list_members(workspace.id)
                            role = member_role(repo, workspace.id, members, user.id)
                        resolver = next((m for m in members if m.user_id == d.resolved_by), None)
                        items.append(
                            InboxItem(
                                decision=DecisionBase(
                                    **d.model_dump(exclude={"subject_content"}),
                                    can_resolve=False,
                                ),
                                resolver_email=resolver.email if resolver else None,
                                project_id=project.id,
                                project_name=project.name,
                                workspace_id=workspace.id,
                                workspace_name=workspace.name,
                            )
                        )
            if not decisions:
                continue
            if members is None:
                members = repo.list_members(workspace.id)
                role = member_role(repo, workspace.id, members, user.id)
            if role is None:
                break  # left the workspace while this request ran
            roles, member_ids, is_admin = _routing_context(repo, project, user.id, role, members)
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


# --------------------------------------------------------------------------- #
# Connected agents: the caller's OAuth grants (hosted MCP)
# --------------------------------------------------------------------------- #


def _own_family_id(family_id: str) -> str | None:
    """`family_id` normalised, or None when it is not a UUID (the column is
    uuid; a malformed id would otherwise be a database error, not a 404)."""
    try:
        return str(uuid.UUID(family_id))
    except ValueError:
        return None


@router.get("/oauth-grants", response_model=list[OAuthGrantOut])
def list_my_oauth_grants(
    request: Request, user: User = Depends(get_current_user)
) -> list[OAuthGrantOut]:
    repo = request.app.state.repository  # pw_oauth_* are service-only
    out: list[OAuthGrantOut] = []
    clients: dict[str, object] = {}
    for fam in repo.list_oauth_families_for_user(user.id):
        if fam.client_id not in clients:
            clients[fam.client_id] = repo.get_oauth_client(fam.client_id)
        client = clients[fam.client_id]
        name, vendor, verified = "", None, False
        if client is not None:
            name = client.client_name
            vendor, verified = classify(client.redirect_uris)
            if vendor == "loopback":
                vendor = None
        out.append(
            OAuthGrantOut(
                family_id=fam.family_id, client_id=fam.client_id, client_name=name,
                vendor=vendor, verified=verified, created_at=fam.created_at,
                last_used_at=fam.last_used_at, revoked_at=fam.revoked_at,
            )
        )  # fmt: skip
    return out


@router.delete("/oauth-grants/{family_id}", status_code=204)
def revoke_my_oauth_grant(
    family_id: str, request: Request, user: User = Depends(get_current_user)
) -> Response:
    repo = request.app.state.repository
    fid = _own_family_id(family_id)
    fam = repo.get_oauth_family(fid) if fid else None
    if fam is None or fam.user_id != user.id:
        raise HTTPException(status_code=404, detail="grant_not_found")
    repo.revoke_oauth_family(fid, "user_revoke", utcnow())
    return Response(status_code=204)


@router.delete("/oauth-grants", status_code=204)
def revoke_all_my_oauth_grants(
    request: Request, user: User = Depends(get_current_user)
) -> Response:
    request.app.state.repository.revoke_oauth_families_for_user(
        user.id, "user_revoke_all", utcnow()
    )
    return Response(status_code=204)
