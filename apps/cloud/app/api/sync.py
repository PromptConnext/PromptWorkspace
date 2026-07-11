"""Projects + Sync API.

The local engine is the source of truth; the cloud holds the shared graph so
collaborators (and business stakeholders) see the same requirement -> spec ->
task -> agent-run -> progress lineage.

Endpoints (this milestone):
  POST /projects                     create a project
  GET  /projects                     list caller's projects
  GET  /projects/{id}                fetch one project
  PUT  /sync/projects/{id}/graph     push a graph delta (upsert)
  GET  /sync/projects/{id}/graph     pull the graph (optionally ?since= cursor)
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request

from app.api._guards import require_project, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    ChangesHead,
    GraphUpsertRequest,
    GraphUpsertResponse,
    Project,
    ProjectCreate,
    ProjectGraph,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

router = APIRouter(tags=["sync"])
logger = logging.getLogger("promptzone.sync")


@router.post("/projects", response_model=Project, status_code=201)
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    # Only members of the target workspace may create projects in it.
    require_workspace(repo, body.workspace_id, user)
    return repo.create_project(
        workspace_id=body.workspace_id, created_by=user.id, name=body.name
    )


@router.get("/projects", response_model=list[Project])
def list_projects(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    return repo.list_projects(user_id=user.id)


@router.get("/projects/{project_id}", response_model=Project)
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    return require_project(repo, project_id, user)


@router.put("/sync/projects/{project_id}/graph", response_model=GraphUpsertResponse)
def push_graph(
    project_id: str,
    payload: GraphUpsertRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GraphUpsertResponse:
    project = require_project(repo, project_id, user)
    counts = repo.upsert_graph(project_id, payload, source=payload.source)
    cursor, _ = repo.changes_head(project_id)
    total = sum(counts.values())
    metrics = getattr(request.app.state, "metrics", None)
    if metrics is not None:
        metrics["pushed"] += 1
        metrics["merged"] += total
    logger.info(
        "graph push project=%s user=%s source=%s counts=%s",
        project_id,
        user.id,
        payload.source,
        counts,
    )
    # Embed-on-ingest (M9): enqueue only, never block this push on a model
    # call. The worker skips nodes whose workspace has no model connection.
    for node_type in RAG_NODE_TYPES:
        for item in getattr(payload, node_type):
            enqueue(
                request.app,
                EmbedJob(project.workspace_id, project_id, node_type, item.id),
            )
    return GraphUpsertResponse(upserted=counts, cursor=cursor)


@router.get("/sync/projects/{project_id}/changes", response_model=ChangesHead)
def changes_head(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Cursor from the last pull; counts reflect changes strictly after it.",
    ),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ChangesHead:
    """Cheap sync head so a polling client can decide whether to pull. When
    `since == head` (nothing new) `has_changes` is False and the client skips
    the full graph pull entirely."""
    require_project(repo, project_id, user)
    cursor, counts = repo.changes_head(project_id, since=since)
    return ChangesHead(cursor=cursor, counts=counts, has_changes=bool(counts))


@router.get("/sync/projects/{project_id}/graph", response_model=ProjectGraph)
def pull_graph(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Return only entities updated strictly after this timestamp.",
    ),
    limit: int | None = Query(
        default=None, ge=1, le=5000, description="Max rows in this page (keyset paginated)."
    ),
    after_ts: datetime | None = Query(
        default=None, description="Keyset continuation: last page's cursor."
    ),
    after_id: str | None = Query(
        default=None, description="Keyset continuation: last page's next_id."
    ),
    request: Request = None,  # type: ignore[assignment]
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ProjectGraph:
    require_project(repo, project_id, user)
    metrics = getattr(request.app.state, "metrics", None) if request else None
    if metrics is not None:
        metrics["pulled"] += 1
    return repo.get_graph(
        project_id, since=since, limit=limit, after_ts=after_ts, after_id=after_id
    )
