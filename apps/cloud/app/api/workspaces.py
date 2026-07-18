"""Workspaces, membership & invitations API (M2).

A workspace is the access-control tier: Admins create it, invite members, and
hold the shared (non-secret) Git configuration. Every project belongs to a
workspace; access is decided by membership, not project ownership.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response

from app.api._guards import require_admin, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    Invitation,
    InvitationCreate,
    InvitationStatus,
    Project,
    Workspace,
    WorkspaceCreate,
    WorkspaceMember,
    WorkspaceUpdate,
    utcnow,
)

router = APIRouter(tags=["workspaces"])

INVITATION_TTL_DAYS = 14


@router.post("/workspaces", response_model=Workspace, status_code=201)
def create_workspace(
    body: WorkspaceCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    return repo.create_workspace(name=body.name, created_by=user.id)


@router.get("/workspaces", response_model=list[Workspace])
def list_workspaces(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Workspace]:
    return repo.list_workspaces(user_id=user.id)


@router.get("/workspaces/{workspace_id}", response_model=Workspace)
def get_workspace(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    return require_workspace(repo, workspace_id, user)


@router.patch("/workspaces/{workspace_id}", response_model=Workspace)
def update_workspace(
    workspace_id: str,
    body: WorkspaceUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    require_admin(repo, workspace_id, user)
    return repo.update_workspace(
        workspace_id,
        name=body.name,
        git_config=body.git_config,
        rag_index_pmo_discussions=body.rag_index_pmo_discussions,
    )


@router.get("/workspaces/{workspace_id}/members", response_model=list[WorkspaceMember])
def list_members(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[WorkspaceMember]:
    require_workspace(repo, workspace_id, user)
    return repo.list_members(workspace_id)


@router.get("/workspaces/{workspace_id}/projects", response_model=list[Project])
def list_workspace_projects(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    require_workspace(repo, workspace_id, user)
    return repo.list_projects_by_workspace(workspace_id)


@router.delete(
    "/workspaces/{workspace_id}/members/{user_id}",
    status_code=204,
    response_class=Response,
)
def remove_member(
    workspace_id: str,
    user_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    require_admin(repo, workspace_id, user)
    if user_id == user.id:
        # Guard against an admin locking a workspace out of all admins by
        # removing themselves; require another admin to do it.
        raise HTTPException(status_code=400, detail="cannot_remove_self")
    repo.remove_member(workspace_id, user_id)
    return Response(status_code=204)


@router.post(
    "/workspaces/{workspace_id}/invitations", response_model=Invitation, status_code=201
)
def create_invitation(
    workspace_id: str,
    body: InvitationCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Invitation:
    require_admin(repo, workspace_id, user)
    invitation = Invitation(
        workspace_id=workspace_id,
        email=body.email,
        role=body.role,
        invited_by=user.id,
        expires_at=utcnow() + timedelta(days=INVITATION_TTL_DAYS),
    )
    return repo.create_invitation(invitation)


@router.get(
    "/workspaces/{workspace_id}/invitations", response_model=list[Invitation]
)
def list_workspace_invitations(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Invitation]:
    require_admin(repo, workspace_id, user)
    return repo.list_invitations(workspace_id, status=InvitationStatus.pending)


@router.delete(
    "/workspaces/{workspace_id}/invitations/{invitation_id}",
    status_code=204,
    response_class=Response,
)
def revoke_workspace_invitation(
    workspace_id: str,
    invitation_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    require_admin(repo, workspace_id, user)
    try:
        repo.revoke_invitation(workspace_id, invitation_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="invitation_not_found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=204)


@router.post("/invitations/{token}/accept", response_model=WorkspaceMember)
def accept_invitation(
    token: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> WorkspaceMember:
    try:
        return repo.accept_invitation(token, user.id)
    except KeyError:
        raise HTTPException(status_code=404, detail="invitation_not_found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
