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

from datetime import datetime

from fastapi import APIRouter, Depends, Query

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

router = APIRouter(tags=["sync"])


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
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GraphUpsertResponse:
    require_project(repo, project_id, user)
    counts = repo.upsert_graph(project_id, payload, source=payload.source)
    graph = repo.get_graph(project_id)
    return GraphUpsertResponse(upserted=counts, cursor=graph.cursor)


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
        description="Return only entities updated strictly after this timestamp (incremental pull).",
    ),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ProjectGraph:
    require_project(repo, project_id, user)
    return repo.get_graph(project_id, since=since)
