"""Model-selection seam (M1, plan 0007; managed fallback added M2). The
Planner always uses the managed Typhoon connection — no BYO model, no
per-stage routing table (removed, docs/superpowers/specs/2026-07-25-cloud-
planner-ui-design.md: "No BYO model in the cloud Planner"). Developers who
want their own model plan through the desktop app instead (apps/engine's
own `runStage()`), which is untouched by this change.
"""

from __future__ import annotations

from app.models.schemas import ModelConnection


def select_model(
    managed_connection: ModelConnection | None = None,
) -> ModelConnection | None:
    return managed_connection
