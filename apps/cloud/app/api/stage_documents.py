"""Raw-markdown side store for Planner stages — GET/PATCH so the Raw|Preview
editor in apps/web can fetch and persist edits independent of the
graph-entity parsing in app/api/generation.py
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md).

"Independent" covers the *parsing*, not the graph: a saved document is applied
to the graph through the same service a generation goes through
(app/generation/stage_apply.py, plan 0018), so the stage after it is unblocked
— and the task board reconciled — whether the document was generated or
written by hand. The PATCH response says how far that got, rather than
returning the raw document and letting the client assume the graph agrees."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from app.api._guards import require_project, require_stage_access
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.stage_apply import ProjectionState, apply_stage_content

router = APIRouter(tags=["stage_documents"])

StageName = Literal["constitution", "specify", "plan", "tasks"]


class StageDocumentOut(BaseModel):
    # Present so the web client can map a stage_documents citation
    # (app/api/assistant.py) back to a stage name — the RAG citation carries
    # the row id, and stage name is what a reader recognises. None when no
    # document has been saved for this stage yet.
    id: str | None
    stage: str
    content: str
    updated_at: str | None


class StageDocumentSaved(StageDocumentOut):
    """A PATCH knows something a GET cannot: whether the graph now reflects
    this document (plan 0018, M4). A read has no projection to report, so the
    field lives on the write response only rather than as a nullable field on
    both."""

    projection: ProjectionState
    # Why `projection` is "failed" (stage_apply's own error vocabulary), so
    # the Planner can say what actually went wrong instead of guessing.
    error: str | None = None
    # Tasks this save tombstoned — dropped from the checklist, or an
    # existing duplicate reference this save consolidated. `tasks` only.
    retired_count: int | None = None


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
        return StageDocumentOut(id=None, stage=stage, content="", updated_at=None)
    return StageDocumentOut(
        id=doc.id, stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat()
    )


@router.patch("/projects/{project_id}/stage-documents/{stage}", response_model=StageDocumentSaved)
def update_stage_document(
    project_id: str,
    stage: StageName,
    body: StageDocumentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentSaved:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    # The save, the graph projection and the RAG enqueues all live in
    # apply_stage_content, so this route and the generation route cannot drift
    # apart again (plan 0018, M1). A projection this content can't produce
    # comes back as projection="failed" rather than as an exception — the
    # document is saved either way, which is the guarantee this endpoint has
    # always made.
    applied = apply_stage_content(
        repo,
        project,
        stage,
        body.content,
        source="manual",
        actor_id=user.id,
        app=request.app,
    )
    return StageDocumentSaved(
        id=applied.document_id,
        stage=stage,
        content=applied.document.content,
        updated_at=applied.document_updated_at,
        projection=applied.projection,
        error=applied.error,
        retired_count=applied.retired_count,
    )
