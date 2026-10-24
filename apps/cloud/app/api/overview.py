"""GET /workspaces/{id}/overview (plan 0033): one card per project, one request."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api._guards import require_admin, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    WorkspaceGovernance,
    WorkspaceGovernanceUpdate,
    WorkspaceOverviewOut,
    utcnow,
)
from app.overview.cards import build_card
from app.policies.scope import validate_scope

router = APIRouter(tags=["overview"])

MAX_PROJECTS = 200


@router.get("/workspaces/{workspace_id}/overview", response_model=WorkspaceOverviewOut)
def get_overview(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> WorkspaceOverviewOut:
    require_workspace(repo, workspace_id, user)
    now = utcnow()
    projects = sorted(
        repo.list_projects_by_workspace(workspace_id), key=lambda p: p.updated_at, reverse=True
    )
    truncated = len(projects) > MAX_PROJECTS
    projects = projects[:MAX_PROJECTS]
    ids = [p.id for p in projects]

    governance = repo.get_workspace_governance(workspace_id) or WorkspaceGovernance.default(
        workspace_id
    )
    tasks_by_project: dict[str, list] = {pid: [] for pid in ids}
    for t in repo.list_tasks_summary(ids):
        tasks_by_project.setdefault(t.project_id, []).append(t)
    receipts = repo.latest_receipt_at(ids)

    cards = [
        build_card(
            p,
            repo.list_project_roles(p.id),
            tasks_by_project[p.id],
            repo.list_decisions(p.id),
            repo.get_repo_analysis(p.id),
            governance,
            receipts.get(p.id),
            now,
        )
        for p in projects
    ]
    return WorkspaceOverviewOut(
        workspace_id=workspace_id,
        generated_at=now,
        members=repo.list_members(workspace_id),
        projects=cards,
        people=[],
        truncated=truncated,
    )


_HATS = {"business_owner", "tech_steward"}


@router.get("/workspaces/{workspace_id}/governance", response_model=WorkspaceGovernance)
def get_governance(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> WorkspaceGovernance:
    """The stored row, or the defaults when none was set. Never writes."""
    require_workspace(repo, workspace_id, user)
    return repo.get_workspace_governance(workspace_id) or WorkspaceGovernance.default(
        workspace_id
    )


@router.put("/workspaces/{workspace_id}/governance", response_model=WorkspaceGovernance)
def put_governance(
    workspace_id: str,
    body: WorkspaceGovernanceUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> WorkspaceGovernance:
    """Admin-only full replace."""
    require_admin(repo, workspace_id, user)
    scope = validate_scope(body.policy_scope.selected, body.policy_scope.custom_text)
    if any(h not in _HATS for h in body.required_hats):
        raise HTTPException(status_code=422, detail="unknown_hat")
    return repo.put_workspace_governance(
        WorkspaceGovernance(
            workspace_id=workspace_id,
            policy_scope=scope,
            required_hats=list(dict.fromkeys(body.required_hats)),
            require_seeded_rules=body.require_seeded_rules,
            updated_by=user.id,
        )
    )
