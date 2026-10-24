"""Planning documents drafted by a local coding agent for an imported project.

Endpoints:
  GET  /projects/{id}/planning-brief                member — everything the agent
                                                    needs to read the repository
                                                    and draft the stages
  POST /projects/{id}/stage-drafts                  per-stage — submit a draft
  GET  /projects/{id}/stage-drafts                  member — the drafts, markdown
                                                    included
  POST /projects/{id}/stage-drafts/{stage}/accept   per-stage — apply the draft
                                                    through apply_stage_content
  POST /projects/{id}/stage-drafts/{stage}/reject   per-stage — keep it, with a
                                                    note for the agent

The brief is member-readable like the stored analysis; what a caller may
*submit* is reported in `submittable_stages`, computed with the same
`require_stage_access` rule the stage-authoring routes enforce.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api._guards import require_project, require_stage_access
from app.api.generation import _codebase_context, requires_repo_analysis
from app.api.stage_documents import StageDocumentSaved
from app.db.repository import Repository
from app.delivery.decisions import latest_decision
from app.dependencies import User, get_current_user, get_repository
from app.generation.parsing import missing_task_refs, parse_task_lines
from app.generation.path_check import unknown_task_paths
from app.generation.prompts import StageKind, agent_planning_instructions, stage_template
from app.generation.stage_apply import apply_stage_content
from app.models.schemas import (
    Project,
    RepoAnalysisStatus,
    Role,
    StageDraft,
    StageDraftIn,
    StageDraftOut,
    StageDraftRejectIn,
    StageDraftStatus,
    StageDraftWarning,
)
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
    repo_url: str | None
    default_branch: str
    # Whether the caller may submit the codebase baseline (workspace admins
    # only); a member's agent skips that step and drafts what it may.
    can_submit_analysis: bool
    policy_context: str
    templates: dict[str, str]
    prd_texts: list[dict[str, str]]
    analysis_status: Literal["none", "snapshot_ready", "baseline_ready", "failed"]
    baseline: str
    drafts: list[PlanningBriefDraft]
    submittable_stages: list[str]
    instructions: str


def _fingerprint(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def predecessor_fingerprint(repo: Repository, project_id: str, stage: str) -> str | None:
    """What a draft for `stage` is being written against, fingerprinted at
    submit time: the predecessor's pending draft if there is one (the agent
    drafts all four stages in one sitting, each from the previous draft),
    else its stored document, else nothing. Constitution has no predecessor."""
    predecessor = PREDECESSOR.get(stage)
    if predecessor is None:
        return None
    pending = repo.get_stage_draft(project_id, predecessor)
    if pending is not None and pending.status == "pending":
        return _fingerprint(pending.markdown)
    document = repo.get_stage_document(project_id, predecessor)
    return _fingerprint(document.content if document is not None else "")


def compute_stale(draft: StageDraft, repo: Repository) -> bool:
    """A draft is stale when its predecessor's stored document no longer has
    the content the draft was written against. Accepting the predecessor's
    draft unchanged keeps it fresh; editing it before or after acceptance
    does not. No predecessor document yet, or no predecessor at all
    (constitution), is not stale."""
    predecessor = PREDECESSOR.get(draft.stage)
    if predecessor is None:
        return False
    document = repo.get_stage_document(draft.project_id, predecessor)
    if document is None:
        return False
    return _fingerprint(document.content) != draft.predecessor_fingerprint


def _require_open_import(project: Project) -> None:
    """Agent planning is for an imported repository that is still being
    planned: a scratch project has no code to read, and after `repo_created`
    there is nothing left to plan against."""
    if not project.is_imported:
        raise HTTPException(status_code=409, detail="repo_not_imported")
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="repo_already_created")


@router.get("/projects/{project_id}/planning-brief", response_model=PlanningBriefOut)
def planning_brief(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
):
    project = require_project(repo, project_id, user)
    _require_open_import(project)

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
        repo_url=project.repo_url,
        default_branch=project.repo_default_branch or "main",
        can_submit_analysis=repo.get_membership(project.workspace_id, user.id) == Role.admin,
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


# --------------------------------------------------------------------------- #
# Drafts: submit, list, accept, reject
# --------------------------------------------------------------------------- #


def _draft_out(
    draft: StageDraft, repo: Repository, warnings: list[StageDraftWarning] | None = None
) -> StageDraftOut:
    return StageDraftOut(
        id=draft.id,
        project_id=draft.project_id,
        stage=draft.stage,
        markdown=draft.markdown,
        source=draft.source,
        model=draft.model,
        status=draft.status,
        stale=compute_stale(draft, repo),
        rejection_note=draft.rejection_note,
        last_error=draft.last_error,
        created_by=draft.created_by,
        created_at=draft.created_at,
        warnings=warnings or [],
    )


def _task_warnings(markdown: str, repo: Repository, project_id: str) -> list[StageDraftWarning]:
    """The same checks a generated tasks document is reported against
    (app/api/generation.py): gaps in the numbering, and paths that are neither
    in the repository nor marked `(new)`. Reported, never rewritten."""
    warnings: list[StageDraftWarning] = []
    gaps = missing_task_refs([t["ref"] for t in parse_task_lines(markdown)])
    if gaps:
        warnings.append(StageDraftWarning(code="missing_task_numbers", items=gaps))
    codebase = _codebase_context(repo.get_repo_analysis(project_id))
    if codebase is not None:
        snapshot = codebase.snapshot
        unknown = unknown_task_paths(
            markdown,
            snapshot.paths,
            listing_complete=(
                not snapshot.tree_truncated and snapshot.file_count <= len(snapshot.paths)
            ),
        )
        if unknown:
            warnings.append(
                StageDraftWarning(
                    code="unmarked_new_paths",
                    items=[{"ref": u.ref, "path": u.path} for u in unknown],
                )
            )
    return warnings


def _require_pending_draft(repo: Repository, project_id: str, stage: str) -> StageDraft:
    draft = repo.get_stage_draft(project_id, stage)
    if draft is None or draft.status != "pending":
        raise HTTPException(status_code=404, detail="draft_not_found")
    return draft


def _require_chain(repo: Repository, project: Project, stage: str) -> None:
    """The pre-checks `generate()` runs before a stage, with the same detail
    codes, so an accepted draft lands only where a generated one could."""
    if stage not in ("plan", "tasks"):
        return
    if requires_repo_analysis(project):
        analysis = repo.get_repo_analysis(project.id) if project.repo_url else None
        if _codebase_context(analysis) is None:
            raise HTTPException(status_code=409, detail="repo_analysis_required")
    if stage == "plan":
        if repo.get_latest_requirement(project.id) is None:
            raise HTTPException(status_code=409, detail="requirement_required")
        intent = latest_decision(repo.list_decisions(project.id), "intent_approval")
        if intent is not None and intent.status in ("open", "rejected"):
            raise HTTPException(status_code=409, detail="intent_not_approved")
    elif repo.get_latest_spec_document(project.id) is None:
        raise HTTPException(status_code=409, detail="spec_document_required")


@router.post(
    "/projects/{project_id}/stage-drafts", response_model=StageDraftOut, status_code=201
)
def submit_stage_draft(
    project_id: str,
    body: StageDraftIn,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDraftOut:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, body.stage, user)
    _require_open_import(project)

    # A fresh draft every time: a resubmission clears the rejection and the
    # last apply error, and its staleness is measured against the
    # predecessor as it is now. The markdown is stored exactly as received;
    # the parsers only produce warnings.
    draft = repo.upsert_stage_draft(
        StageDraft(
            project_id=project.id,
            workspace_id=project.workspace_id,
            stage=body.stage,
            markdown=body.markdown,
            model=body.model,
            predecessor_fingerprint=predecessor_fingerprint(repo, project.id, body.stage),
            created_by=user.id,
        )
    )
    warnings = _task_warnings(body.markdown, repo, project.id) if body.stage == "tasks" else []
    return _draft_out(draft, repo, warnings)


@router.get("/projects/{project_id}/stage-drafts", response_model=list[StageDraftOut])
def list_stage_drafts(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[StageDraftOut]:
    require_project(repo, project_id, user)
    return [_draft_out(d, repo) for d in repo.list_stage_drafts(project_id)]


@router.post(
    "/projects/{project_id}/stage-drafts/{stage}/accept", response_model=StageDocumentSaved
)
def accept_stage_draft(
    project_id: str,
    stage: StageKind,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentSaved:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    draft = _require_pending_draft(repo, project_id, stage)
    _require_chain(repo, project, stage)

    applied = apply_stage_content(
        repo,
        project,
        stage,
        draft.markdown,
        source="agent",
        actor_id=user.id,
        app=request.app,
    )
    if applied.projection == "failed":
        # The document is saved either way; the draft stays, carrying why the
        # graph refused it, so the human can see it and the agent can fix it.
        repo.upsert_stage_draft(draft.model_copy(update={"last_error": applied.error}))
    else:
        repo.delete_stage_draft(project_id, stage)
    return StageDocumentSaved(
        id=applied.document_id,
        stage=stage,
        content=applied.document.content,
        updated_at=applied.document_updated_at,
        projection=applied.projection,
        error=applied.error,
        retired_count=applied.retired_count,
        retired_refs=applied.retired_refs,
    )


@router.post(
    "/projects/{project_id}/stage-drafts/{stage}/reject", response_model=StageDraftOut
)
def reject_stage_draft(
    project_id: str,
    stage: StageKind,
    body: StageDraftRejectIn,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDraftOut:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    draft = repo.get_stage_draft(project_id, stage)
    if draft is None:
        raise HTTPException(status_code=404, detail="draft_not_found")
    rejected = repo.upsert_stage_draft(
        draft.model_copy(update={"status": "rejected", "rejection_note": body.note or None})
    )
    return _draft_out(rejected, repo)
