"""Model-selection seam (M1, plan 0007; managed fallback added M2).

A workspace's own BYO connection always wins. With none configured, this
falls back to the platform-operated managed Typhoon connection (M2) when
one was built at startup (app/generation/managed.py) — otherwise `None`,
same "not configured" outcome as before M2. M3 replaces this whole function
with the real per-stage/per-workspace routing table (managed vs BYO,
overridable per project); every call site already goes through this one
seam, so that swap stays a change in one place.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.generation.prompts import StageKind
from app.models.schemas import ModelConnection


def select_model(
    repo: Repository,
    workspace_id: str,
    project_id: str,
    stage: StageKind,
    managed_connection: ModelConnection | None = None,
) -> ModelConnection | None:
    byo = repo.get_model_connection(workspace_id)
    if byo is not None:
        return byo
    return managed_connection
