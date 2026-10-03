"""The Planner form answers behind a stage — GET/PUT so the web form is the
same on every device and for every member of the project.

A stage document (app/api/stage_documents.py) is what a generation produced;
these are what the author asked for. They live in their own table rather than
on the document row so that saving answers before the first generation never
creates a document: everything that asks "does this stage have a document"
(the Planner's done-state, RAG, repository seeding) keeps its answer.

Writing follows the stage's authoring rule (`require_stage_access`): the
answers to `constitution` and `plan` are as admin-only as generating them.
Reading is open to any member, like the documents themselves.

PUT replaces the stage's answers wholesale, last writer wins — deliberately.
There is no version check or 409: two members editing the same form at once
is rare, the answers are a prompt rather than a record, and the loser's text
is still on their screen to re-apply. Revisit with an `updated_at` precondition
if concurrent editing becomes a real workflow.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator

from app.api._guards import require_project, require_stage_access
from app.db.repository import Repository, StageInputsUnavailable
from app.dependencies import User, get_current_user, get_repository

router = APIRouter(tags=["stage_inputs"])

# Only the stages the Planner shows a form for; `tasks` sends a fixed prompt.
FormStage = Literal["constitution", "specify", "plan"]

MAX_KEYS = 40
MAX_KEY_LENGTH = 100
MAX_VALUE_LENGTH = 20_000


class StageInputsOut(BaseModel):
    stage: str
    inputs: dict[str, str]
    updated_at: str | None
    updated_by: str | None


class StageInputsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inputs: dict[StrictStr, StrictStr] = Field(max_length=MAX_KEYS)

    @field_validator("inputs")
    @classmethod
    def _bounded(cls, value: dict[str, str]) -> dict[str, str]:
        for key, answer in value.items():
            if not key or len(key) > MAX_KEY_LENGTH:
                raise ValueError(f"keys must be 1-{MAX_KEY_LENGTH} characters")
            if len(answer) > MAX_VALUE_LENGTH:
                raise ValueError(f"answer '{key}' exceeds {MAX_VALUE_LENGTH} characters")
        return value


@router.get("/projects/{project_id}/stage-inputs/{stage}", response_model=StageInputsOut)
def get_stage_inputs(
    project_id: str,
    stage: FormStage,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageInputsOut:
    require_project(repo, project_id, user)
    # A database without migration 0003 reads as "no answers" (the adapter
    # maps the missing table to None), so the form still opens.
    row = repo.get_stage_inputs(project_id, stage)
    if row is None:
        return StageInputsOut(stage=stage, inputs={}, updated_at=None, updated_by=None)
    return StageInputsOut(
        stage=stage,
        inputs=row.inputs,
        updated_at=row.updated_at.isoformat(),
        updated_by=row.updated_by,
    )


@router.put("/projects/{project_id}/stage-inputs/{stage}", response_model=StageInputsOut)
def put_stage_inputs(
    project_id: str,
    stage: FormStage,
    body: StageInputsUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageInputsOut:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    try:
        row = repo.upsert_stage_inputs(
            project_id, project.workspace_id, stage, body.inputs, user.id
        )
    except StageInputsUnavailable:
        raise HTTPException(status_code=503, detail="stage_inputs_unavailable") from None
    return StageInputsOut(
        stage=stage,
        inputs=row.inputs,
        updated_at=row.updated_at.isoformat(),
        updated_by=row.updated_by,
    )
