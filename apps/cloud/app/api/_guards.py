"""Shared authorization guards: workspace membership & admin role.

App-layer checks are the primary access control; when the backend forwards the
caller's JWT to Supabase, RLS enforces the same rules a second time.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.db.repository import Repository
from app.dependencies import User
from app.models.schemas import Project, Role, Workspace


def require_workspace(repo: Repository, workspace_id: str, user: User) -> Workspace:
    ws = repo.get_workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    if repo.get_membership(workspace_id, user.id) is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    return ws


def require_admin(repo: Repository, workspace_id: str, user: User) -> Workspace:
    ws = repo.get_workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    if repo.get_membership(workspace_id, user.id) != Role.admin:
        raise HTTPException(status_code=403, detail="admin_required")
    return ws


# Spec Kit stages only a workspace admin may author. Both belong to the Tech
# Lead's step in the Planner: `plan` is the technical breakdown, and
# `constitution` is the standing rules seeded into the repository as AGENTS.md.
# Writing either (generate, prefill, save) is admin-only. Reading is never
# gated here: a business user can still open them, they just can't author them.
ADMIN_ONLY_STAGES = frozenset({"constitution", "plan"})


def require_stage_access(repo: Repository, project: Project, stage: str, user: User) -> None:
    """Authorization for *authoring* a stage, on top of project membership."""
    if stage in ADMIN_ONLY_STAGES:
        require_admin(repo, project.workspace_id, user)


def require_project(repo: Repository, project_id: str, user: User) -> Project:
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project_not_found")
    if repo.get_membership(project.workspace_id, user.id) is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    return project
