"""Health / readiness endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app import __version__
from app.db.repository import Repository
from app.dependencies import get_repository
from app.models.schemas import utcnow

router = APIRouter(tags=["health"])


@router.get("/health")
def health(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    state = request.app.state
    return {
        "status": "ok",
        "service": "promptconnext-cloud",
        "version": __version__,
        "backend": repo.backend_name,
        "schema_version": getattr(state, "schema_version", "unknown"),
        "env": state.settings.app_env,
        "metrics": getattr(state, "metrics", {}),
        "time": utcnow().isoformat(),
    }
