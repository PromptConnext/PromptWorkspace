"""GET /workspaces/{id}/overview (plan 0033): one card per project, one request."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api._guards import require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import WorkspaceGovernance, WorkspaceOverviewOut, utcnow
from app.overview.cards import build_card

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
