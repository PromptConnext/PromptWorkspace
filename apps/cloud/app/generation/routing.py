"""Model-selection seam (M1, plan 0007; managed fallback added M2; the real
per-stage routing table added M3).

Resolution order: project override -> workspace override -> the hard-coded
`DEFAULT_STAGE_ROUTING`. A workspace's own BYO connection is always used
when the resolved source is "byo"; the managed connection (built once at
startup, app/generation/managed.py) is used when it's "managed" — falling
back to BYO if the managed tier isn't configured at all, so an operator who
never sets MANAGED_MODEL_* doesn't silently break every default-managed
stage. `plan` is the one stage ADR 0013 warns not to silently degrade
(managed Typhoon underperforms on it): if routing resolves `plan` to "byo"
(the default, or an explicit override) and no BYO connection exists,
`select_model` raises `PlanRequiresModelError` instead of returning `None`
or quietly falling back to managed.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.generation.prompts import StageKind
from app.models.schemas import ModelConnection

# ADR 0013's routing table: constitution/specify/tasks default to the free
# managed tier; plan defaults to BYO/frontier (managed Typhoon underperforms
# on planning per the ADR).
DEFAULT_STAGE_ROUTING: dict[StageKind, str] = {
    "constitution": "managed",
    "specify": "managed",
    "plan": "byo",
    "tasks": "managed",
}


class PlanRequiresModelError(ValueError):
    def __init__(self) -> None:
        super().__init__(
            "plan requires a connected model — connect a key or route it to the managed tier"
        )


def resolve_stage_source(
    repo: Repository, workspace_id: str, project_id: str, stage: StageKind
) -> str:
    project_override = repo.get_stage_routing_override(workspace_id, project_id, stage)
    if project_override is not None:
        return project_override.model_source
    workspace_override = repo.get_stage_routing_override(workspace_id, None, stage)
    if workspace_override is not None:
        return workspace_override.model_source
    return DEFAULT_STAGE_ROUTING[stage]


def select_model(
    repo: Repository,
    workspace_id: str,
    project_id: str,
    stage: StageKind,
    managed_connection: ModelConnection | None = None,
) -> ModelConnection | None:
    source = resolve_stage_source(repo, workspace_id, project_id, stage)
    byo = repo.get_model_connection(workspace_id)

    if source == "managed":
        return managed_connection if managed_connection is not None else byo

    # source == "byo"
    if byo is not None:
        return byo
    if stage == "plan":
        raise PlanRequiresModelError()
    return None
