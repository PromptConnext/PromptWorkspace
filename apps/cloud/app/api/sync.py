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

from fastapi import APIRouter, Depends, HTTPException, Query

from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    GraphUpsertRequest,
    GraphUpsertResponse,
    Project,
    ProjectCreate,
    ProjectGraph,
)

router = APIRouter(tags=["sync"])


def _require_project(repo: Repository, project_id: str, user: User) -> Project:
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project_not_found")
    if project.owner_id != user.id:
        # Collaboration/sharing lands with real auth; for now, owner-only.
        raise HTTPException(status_code=403, detail="not_project_owner")
    return project


@router.post("/projects", response_model=Project, status_code=201)
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    return repo.create_project(owner_id=user.id, name=body.name)


@router.get("/projects", response_model=list[Project])
def list_projects(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    return repo.list_projects(owner_id=user.id)


@router.get("/projects/{project_id}", response_model=Project)
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    return _require_project(repo, project_id, user)


@router.put("/sync/projects/{project_id}/graph", response_model=GraphUpsertResponse)
def push_graph(
    project_id: str,
    payload: GraphUpsertRequest,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GraphUpsertResponse:
    _require_project(repo, project_id, user)
    counts = repo.upsert_graph(project_id, payload)
    graph = repo.get_graph(project_id)
    return GraphUpsertResponse(upserted=counts, cursor=graph.cursor)


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
    _require_project(repo, project_id, user)
    return repo.get_graph(project_id, since=since)
