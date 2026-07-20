"""Stage routing table endpoints (M3, plan 0007): read the effective
per-stage model source (workspace default or project override, falling back
to `DEFAULT_STAGE_ROUTING`) and let an admin write an override at either
level. Consumed by the web app's "Model source" settings panel.

Resolution mirrors `app/generation/routing.py::resolve_stage_source` but
also reports which level a value came from (`origin`) and the specific
`model` override, if any — detail the generation-time resolver doesn't need
but the settings UI does.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api._guards import require_admin, require_project, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.prompts import StageKind
from app.generation.routing import DEFAULT_STAGE_ROUTING
from app.models.schemas import EffectiveStageRouting, RoutingTableOut, StageRoutingUpdate

router = APIRouter(tags=["routing"])

_STAGES: tuple[StageKind, ...] = ("constitution", "specify", "plan", "tasks")


def _effective_stage(
    repo: Repository, workspace_id: str, project_id: str | None, stage: StageKind
) -> EffectiveStageRouting:
    if project_id is not None:
        project_override = repo.get_stage_routing_override(workspace_id, project_id, stage)
        if project_override is not None:
            return EffectiveStageRouting(
                stage=stage,
                model_source=project_override.model_source,
                model=project_override.model,
                origin="project",
            )
    workspace_override = repo.get_stage_routing_override(workspace_id, None, stage)
    if workspace_override is not None:
        return EffectiveStageRouting(
            stage=stage,
            model_source=workspace_override.model_source,
            model=workspace_override.model,
            origin="workspace",
        )
    return EffectiveStageRouting(
        stage=stage, model_source=DEFAULT_STAGE_ROUTING[stage], model=None, origin="default"
    )


@router.get("/workspaces/{workspace_id}/routing", response_model=RoutingTableOut)
def get_workspace_routing(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RoutingTableOut:
    require_workspace(repo, workspace_id, user)
    return RoutingTableOut(
        routing=[_effective_stage(repo, workspace_id, None, stage) for stage in _STAGES]
    )


@router.put("/workspaces/{workspace_id}/routing", response_model=EffectiveStageRouting)
def put_workspace_routing(
    workspace_id: str,
    body: StageRoutingUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> EffectiveStageRouting:
    require_admin(repo, workspace_id, user)
    repo.upsert_stage_routing(workspace_id, None, body.stage, body.model_source, body.model)
    return _effective_stage(repo, workspace_id, None, body.stage)


@router.get("/projects/{project_id}/routing", response_model=RoutingTableOut)
def get_project_routing(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RoutingTableOut:
    project = require_project(repo, project_id, user)
    return RoutingTableOut(
        routing=[
            _effective_stage(repo, project.workspace_id, project_id, stage) for stage in _STAGES
        ]
    )


@router.put("/projects/{project_id}/routing", response_model=EffectiveStageRouting)
def put_project_routing(
    project_id: str,
    body: StageRoutingUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> EffectiveStageRouting:
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    repo.upsert_stage_routing(
        project.workspace_id, project_id, body.stage, body.model_source, body.model
    )
    return _effective_stage(repo, project.workspace_id, project_id, body.stage)
