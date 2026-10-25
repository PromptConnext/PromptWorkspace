"""Health / readiness endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app import __version__
from app.capacity import capacity_snapshot
from app.db.repository import Repository
from app.dependencies import get_repository
from app.models.schemas import utcnow
from app.schema_gate import SchemaStatus, read_status

router = APIRouter(tags=["health"])


def _schema_block(status: SchemaStatus) -> dict:
    return {
        "state": status.state,
        "pending": status.pending,
        "applied_latest": status.applied_latest,
    }


def _body(request: Request, repo: Repository) -> dict:
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
        "schema": _schema_block(read_status(request.app)),
        "time": utcnow().isoformat(),
    }


@router.get("/health")
def health(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    """Liveness. Always 200, even when the database is behind the code."""
    return _body(request, repo)


@router.get("/ready")
def ready(request: Request, repo: Repository = Depends(get_repository)):
    """Readiness: 503 while the database is behind the code, 200 otherwise.

    Separate from `/health` because the platform's liveness probe also hits
    `/health`, so a 503 there would restart-loop the container. An unreadable
    ledger (`unknown`) counts as ready: the gate blocks on positive evidence only.
    """
    body = _body(request, repo)
    if body["schema"]["state"] == "behind":
        body["status"] = "schema_behind"
        return JSONResponse(status_code=503, content=body)
    return body
