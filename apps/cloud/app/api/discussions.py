"""Discussion authoring API (M12).

  POST /projects/{id}/discussions   member — create a pz-native comment

The one deliberate exception to the "read-first, authoring stays on
desktop" rule (M8): comments are collaboration data, not planning
artifacts, so both web and desktop may author them. Reads aren't a new
endpoint — discussions ride the existing `GET /sync/projects/{id}/graph`
(`ProjectGraph.discussions`), same as every other entity.

`author` is always the authenticated caller, never client-supplied, and
`source` is always "pz" here — the only other writer of pz_discussions rows
is the Jira comment mirror (app/api/integrations.py), which pushes
source="pmo" through the same repo.upsert_graph() path this endpoint uses.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import ENTITY_TYPES, Discussion, DiscussionCreate, GraphUpsertRequest
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

router = APIRouter(tags=["discussions"])

_VALID_PARENT_TYPES = {t for t in ENTITY_TYPES if t != "discussions"}


@router.post("/projects/{project_id}/discussions", response_model=Discussion, status_code=201)
def create_discussion(
    project_id: str,
    body: DiscussionCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Discussion:
    project = require_project(repo, project_id, user)
    if body.parent_node_type not in _VALID_PARENT_TYPES:
        raise HTTPException(status_code=422, detail="invalid_parent_node_type")
    if repo.get_node(project_id, body.parent_node_type, body.parent_node_id) is None:
        raise HTTPException(status_code=404, detail="parent_node_not_found")

    discussion = Discussion(
        project_id=project_id,
        parent_node_type=body.parent_node_type,
        parent_node_id=body.parent_node_id,
        author=user.id,
        body=body.body,
        source="pz",
    )
    repo.upsert_graph(project_id, GraphUpsertRequest(discussions=[discussion]), source="pz")

    # Embed-on-ingest, same rule as sync.py's push handler: never block this
    # request on a model call, just enqueue.
    if "discussions" in RAG_NODE_TYPES:
        enqueue(
            request.app,
            EmbedJob(project.workspace_id, project_id, "discussions", discussion.id),
        )

    return discussion
