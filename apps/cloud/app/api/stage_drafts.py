"""Planning documents drafted by a local coding agent for an imported project.

Endpoints:
  GET /projects/{id}/planning-brief   member — everything the agent needs to
                                      read the repository and draft the stages

The brief is member-readable like the stored analysis; what a caller may
*submit* is reported in `submittable_stages`, computed with the same
`require_stage_access` rule the stage-authoring routes enforce.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api._guards import require_project, require_stage_access
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.prompts import StageKind, agent_planning_instructions, stage_template
from app.models.schemas import RepoAnalysisStatus, StageDraft, StageDraftStatus
from app.policies.registry import render_policy_context

router = APIRouter(tags=["stage_drafts"])

STAGES: tuple[StageKind, ...] = ("constitution", "specify", "plan", "tasks")

# The stage whose stored document a draft was written against.
PREDECESSOR: dict[str, str] = {"specify": "constitution", "plan": "specify", "tasks": "plan"}

POLICY_CONTEXT_MAX_CHARS = 30_000
PRD_TEXT_MAX_CHARS = 40_000


class PlanningBriefDraft(BaseModel):
    stage: str
    status: StageDraftStatus
    stale: bool
    rejection_note: str | None = None
    last_error: str | None = None
    created_at: datetime


class PlanningBriefOut(BaseModel):
    project_id: str
    project_name: str
    project_description: str
    policy_context: str
    templates: dict[str, str]
    prd_texts: list[dict[str, str]]
    analysis_status: Literal["none", "snapshot_ready", "baseline_ready", "failed"]
    baseline: str
    drafts: list[PlanningBriefDraft]
    submittable_stages: list[str]
    instructions: str


def compute_stale(draft: StageDraft, repo: Repository) -> bool:
    """A draft is stale when the stage document it was written against has
    been saved since the draft was submitted. No predecessor document, or no
    predecessor at all (constitution), is not stale."""
    predecessor = PREDECESSOR.get(draft.stage)
    if predecessor is None:
        return False
    document = repo.get_stage_document(draft.project_id, predecessor)
    return document is not None and document.updated_at > draft.created_at


@router.get("/projects/{project_id}/planning-brief", response_model=PlanningBriefOut)
def planning_brief(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
):
    project = require_project(repo, project_id, user)
    if not project.is_imported:
        raise HTTPException(status_code=409, detail="repo_not_imported")
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="repo_already_created")

    submittable: list[str] = []
    for stage in STAGES:
        try:
            require_stage_access(repo, project, stage, user)
        except HTTPException:
            continue
        submittable.append(stage)

    analysis = repo.get_repo_analysis(project_id)
    status: RepoAnalysisStatus | Literal["none"] = analysis.status if analysis else "none"
    return PlanningBriefOut(
        project_id=project.id,
        project_name=project.name,
        # Project has no description column yet; the field is part of the contract.
        project_description="",
        policy_context=render_policy_context(
            project.policy_scope, max_chars=POLICY_CONTEXT_MAX_CHARS
        ),
        templates={s: stage_template(s, existing_repo=True) for s in STAGES},
        prd_texts=[
            {"title": d.title, "text": d.extracted_text[:PRD_TEXT_MAX_CHARS]}
            for d in repo.list_documents(project_id)
            if d.extracted_text
        ],
        analysis_status=status,
        baseline=analysis.baseline if analysis else "",
        drafts=[
            PlanningBriefDraft(
                stage=d.stage,
                status=d.status,
                stale=compute_stale(d, repo),
                rejection_note=d.rejection_note,
                last_error=d.last_error,
                created_at=d.created_at,
            )
            for d in repo.list_stage_drafts(project_id)
        ],
        submittable_stages=submittable,
        instructions=agent_planning_instructions(),
    )
