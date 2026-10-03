"""Workspaces, membership & invitations API (M2).

A workspace is the access-control tier: Admins create it, invite members, and
hold the shared (non-secret) Git configuration. Every project belongs to a
workspace; access is decided by membership, not project ownership.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api._guards import require_admin, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    Invitation,
    InvitationCreate,
    InvitationCreateResponse,
    InvitationStatus,
    PendingInvitation,
    Project,
    Workspace,
    WorkspaceCreate,
    WorkspaceMember,
    WorkspaceUpdate,
    utcnow,
)

router = APIRouter(tags=["workspaces"])

INVITATION_TTL_DAYS = 14


def _pending_invitations_for(repo: Repository, user: User) -> list[Invitation]:
    """Live (pending, unexpired) invitations addressed to this user's email.

    Empty when the account has no email (stub auth without one) — there is
    nothing to match an invitation row against.
    """
    if not user.email:
        return []
    now = utcnow()
    return [
        inv
        for inv in repo.list_invitations_for_email(user.email, status=InvitationStatus.pending)
        if inv.expires_at > now
    ]


def _personal_workspace_name(user: User) -> str:
    """Default name for an auto-provisioned personal workspace.

    Prefers the email local-part (friendlier, and in stub mode that is just the
    user id) and falls back to the raw user id when no email is present.
    """
    handle = user.email.split("@", 1)[0] if user.email else user.id
    return f"{handle}'s workspace"


@router.post("/workspaces", response_model=Workspace, status_code=201)
def create_workspace(
    body: WorkspaceCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    return repo.create_workspace(name=body.name, created_by=user.id, created_by_email=user.email)


@router.get("/workspaces", response_model=list[Workspace])
def list_workspaces(
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Workspace]:
    workspaces = repo.list_workspaces(user_id=user.id)
    # ADR 0015 §5 / plan 0006 G1: on a first authenticated resolve with ZERO
    # memberships, auto-provision a personal workspace so the desktop
    # membership gate never dead-ends a brand-new account. Idempotent — a
    # no-op once any membership exists (an invited user who already accepted
    # gets none). Reuses the same create path migration 0007 fixed, so the
    # creator's admin row satisfies pw_is_admin without a bootstrap deadlock.
    #
    # Suppressed while a live invitation addressed to this user is outstanding:
    # the root layout's workspace provider calls this endpoint on *every* route,
    # including /invite/{token}, so without the guard a brand-new invitee races
    # a personal workspace into existence before (or instead of) accepting, and
    # the gate then auto-enters that junk workspace. Once the invite is accepted
    # the membership exists and the branch is a no-op anyway; if the invite is
    # left to expire or be revoked, the next resolve provisions as before.
    if (
        not workspaces
        and request.app.state.settings.auto_provision_personal_workspace
        and not _pending_invitations_for(repo, user)
    ):
        repo.create_workspace(
            name=_personal_workspace_name(user),
            created_by=user.id,
            created_by_email=user.email or None,
        )
        workspaces = repo.list_workspaces(user_id=user.id)
    return workspaces


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
    "/workspaces/{workspace_id}/invitations",
    response_model=InvitationCreateResponse,
    status_code=201,
)
def create_invitation(
    workspace_id: str,
    body: InvitationCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> InvitationCreateResponse:
    require_admin(repo, workspace_id, user)
    invitation = Invitation(
        workspace_id=workspace_id,
        email=body.email,
        role=body.role,
        invited_by=user.id,
        expires_at=utcnow() + timedelta(days=INVITATION_TTL_DAYS),
    )
    saved = repo.create_invitation(invitation)
    web = request.app.state.settings.web_app_url.rstrip("/")
    accept_url = f"{web}/invite/{saved.token}"
    email_sent = request.app.state.invitation_mailer.send(saved.email, saved.token)
    return InvitationCreateResponse(invitation=saved, accept_url=accept_url, email_sent=email_sent)


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


@router.get("/invitations/pending", response_model=list[PendingInvitation])
def list_my_pending_invitations(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[PendingInvitation]:
    """Invitations addressed to the caller that are still live.

    The recovery path when the invite link is lost — a mail client mangles it,
    or the auth provider bounces the user to the site root instead of
    /invite/{token}. Scoped by the caller's own email, so it exposes nothing an
    admin didn't already address to them.
    """
    out: list[PendingInvitation] = []
    for inv in _pending_invitations_for(repo, user):
        workspace = repo.get_workspace(inv.workspace_id)
        if workspace is None:
            continue  # workspace deleted out from under the invite
        out.append(
            PendingInvitation(
                token=inv.token,
                workspace_id=inv.workspace_id,
                workspace_name=workspace.name,
                role=inv.role,
                invited_by=inv.invited_by,
                expires_at=inv.expires_at,
            )
        )
    return out


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
