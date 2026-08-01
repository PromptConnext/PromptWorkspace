"""Raw-markdown side store for Planner stages — GET/PATCH so the Raw|Preview
editor in apps/web can fetch and persist edits independent of the
graph-entity parsing in app/api/generation.py
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md).

"Independent" covers the *parsing*, not the graph: a saved `specify` or `plan`
document is projected onto the same Requirement / SpecDocument a generation
would have produced (app/generation/projection.py), so the stage after it is
unblocked whether the document was generated or written by hand."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.api._guards import require_project, require_stage_access
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.projection import project_stage_document
from app.rag.queue import EmbedJob, enqueue

logger = logging.getLogger("promptconnext.stage_documents")

router = APIRouter(tags=["stage_documents"])

StageName = Literal["constitution", "specify", "plan", "tasks"]


class StageDocumentOut(BaseModel):
    stage: str
    content: str
    updated_at: str | None


class StageDocumentUpdate(BaseModel):
    content: str


@router.get("/projects/{project_id}/stage-documents/{stage}", response_model=StageDocumentOut)
def get_stage_document(
    project_id: str,
    stage: StageName,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentOut:
    require_project(repo, project_id, user)
    doc = repo.get_stage_document(project_id, stage)
    if doc is None:
        return StageDocumentOut(stage=stage, content="", updated_at=None)
    return StageDocumentOut(stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat())


@router.patch("/projects/{project_id}/stage-documents/{stage}", response_model=StageDocumentOut)
def update_stage_document(
    project_id: str,
    stage: StageName,
    body: StageDocumentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentOut:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    doc = repo.upsert_stage_document(project_id, project.workspace_id, stage, body.content, user.id)
    enqueue(request.app, EmbedJob(project.workspace_id, project_id, "stage_documents", doc.id))
    try:
        project_stage_document(repo, project, stage, body.content)
    except Exception:
        # The document itself is already saved. A failed projection costs the
        # next stage its unlock, not the user's text, so it must not 500 the
        # save that would otherwise have succeeded.
        logger.exception(
            "graph projection failed for project=%s stage=%s", project_id, stage
        )
    return StageDocumentOut(stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat())
