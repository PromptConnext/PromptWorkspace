"""Model-selection seam (M1, plan 0007).

Always returns the workspace's BYO connection for now. M3 fills this in with
the real per-stage/per-workspace routing table (managed Typhoon vs BYO,
overridable per project) — introducing the seam here, with every call site
already going through it, means M3 is a change in one place.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.generation.prompts import StageKind
from app.models.schemas import ModelConnection


def select_model(
    repo: Repository, workspace_id: str, project_id: str, stage: StageKind
) -> ModelConnection | None:
    return repo.get_model_connection(workspace_id)
