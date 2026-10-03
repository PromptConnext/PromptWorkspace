"""Health / readiness endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app import __version__
from app.capacity import capacity_snapshot
from app.db.repository import Repository
from app.dependencies import get_repository
from app.models.schemas import utcnow

router = APIRouter(tags=["health"])


@router.get("/health")
def health(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    state = request.app.state
    return {
        "status": "ok",
        "service": "promptworkspace-cloud",
        "version": __version__,
        "backend": repo.backend_name,
        "schema_version": getattr(state, "schema_version", "unknown"),
        "env": state.settings.app_env,
        # Cumulative sync counters (M7). Incremented by app/api/sync.py; they
        # only ever go up, and they are about work done, not about capacity.
        "metrics": getattr(state, "metrics", {}),
        # Point-in-time gauges for the four components that cap this service at
        # one container, plus the id an external uptime monitor compares across
        # polls to notice a second one (plan 0021 M4, app/capacity.py).
        # Additive: existing consumers read "metrics" and are untouched.
        "capacity": capacity_snapshot(state),
        "time": utcnow().isoformat(),
    }
