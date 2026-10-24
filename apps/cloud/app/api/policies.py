"""Policy Scope endpoints (C4, Policy Scope feature):

  GET   /policy-templates                     list the built-in compliance templates
  PATCH /projects/{project_id}/policy-scope    set a project's policy scope

Deliberately **not** gated by `require_stage_access`/`ADMIN_ONLY_STAGES`
(app/api/_guards.py) — policy scope is planning input any project member
(including a business user with no stage-authoring rights) may select, not
stage authoring like `constitution`/`plan`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import PolicyScopeUpdate, Project, WorkspaceGovernance
from app.policies.registry import BUILTIN_TEMPLATES, template_body
from app.policies.scope import validate_scope

router = APIRouter(tags=["policies"])

class PolicyTemplateOut(BaseModel):
    id: str
    name: str
    description: str
    body: str


@router.get("/policy-templates", response_model=list[PolicyTemplateOut])
def list_policy_templates(
    # Accepted but unused today — the future org-template merge (deferred,
    # designed-for) lands in this same endpoint with no web contract change:
    # `ws:`-prefixed rows would be appended to the built-ins below.
    workspace_id: str | None = None,
    user: User = Depends(get_current_user),
) -> list[PolicyTemplateOut]:
    return [
        PolicyTemplateOut(id=t.id, name=t.name, description=t.description, body=template_body(t.id))
        for t in BUILTIN_TEMPLATES
    ]


@router.patch("/projects/{project_id}/policy-scope", response_model=Project)
def update_policy_scope(
    project_id: str,
    body: PolicyScopeUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Full-replace semantics. Any project member may edit — scope is
    planning input, not stage authoring (see module docstring)."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="project_frozen")

    scope = validate_scope(body.selected, body.custom_text)
    return repo.update_project_policy_scope(project_id, scope, source="project")


@router.post("/projects/{project_id}/policy-scope/use-workspace", response_model=Project)
def use_workspace_policy_scope(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Drop the project's own scope and follow the workspace's again."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="project_frozen")
    governance = repo.get_workspace_governance(
        project.workspace_id
    ) or WorkspaceGovernance.default(project.workspace_id)
    return repo.update_project_policy_scope(
        project_id, governance.policy_scope.model_copy(deep=True), source="workspace"
    )
