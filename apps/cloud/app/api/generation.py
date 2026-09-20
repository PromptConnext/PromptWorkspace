"""Stage generation endpoints (M1, plan 0007): the cloud-side Spec Kit path
for business users with no desktop app to run the engine's own `runStage()`
(ADR 0013, plan 0007's "surface decision"). Same auth/membership/rate-limit/
budget stack as the RAG assistant (app/api/assistant.py) — a parallel,
self-contained generation path, not a relay to a running local engine.

Model selection (`select_model`, `app/generation/routing.py`) is
unconditionally the platform-operated managed Typhoon connection (M2) —
there is no BYO fallback and no per-stage routing table in the Planner as
of the cloud Planner UI feature (docs/superpowers/specs/2026-07-25-cloud-
planner-ui-design.md); business users never connect their own key here.
Developers who want their own model plan through the desktop app instead
(apps/engine's own `runStage()`), which this change leaves untouched.

Persistence mirrors what the engine's own stage routes already do
(apps/engine/src/routes/projects.ts): `specify` lands on a Requirement,
`plan` on a SpecDocument against the latest requirement, `tasks` on Task rows
parsed out of the checklist. None of that lives here any more — it is
app/generation/stage_apply.py, shared with the manual-edit route so a
generated and a hand-written stage cannot diverge (plan 0018).
`constitution` has no graph entity to land on (it's project-level
governance text, not a per-requirement artifact) — it streams back to the
caller and is recorded in `generation_runs`, but isn't itself persisted to
the graph.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api._guards import require_project, require_stage_access
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.prefill import SYSTEM_PROMPT as PREFILL_SYSTEM_PROMPT
from app.generation.prefill import build_prompt as build_prefill_prompt
from app.generation.prefill import parse_prefill
from app.generation.prompts import StageKind, driver_prompt
from app.generation.routing import select_model
from app.generation.service import GenerationError, HttpGenerationProvider, parse_stage_output
from app.generation.stage_apply import StageApplyResult, apply_stage_content
from app.models.schemas import (
    GenerateRequest,
    GenerationRun,
    Project,
    Requirement,
    SpecDocument,
)
from app.policies.registry import render_policy_context, render_policy_summary
from app.rag.budget import estimate_tokens

logger = logging.getLogger("promptconnext.generation")
router = APIRouter(tags=["generation"])

# Key for the managed source's *global* rate limiter (app.state.managed_limiter)
# — one shared free Typhoon key, so this is deliberately not per-workspace.
_MANAGED_LIMITER_KEY = "managed:typhoon"


def _resolve_model(request: Request, project):
    """Model selection plus the two throttles every model-backed endpoint here
    shares: the managed tier's global rate limit and the workspace's daily
    token budget."""
    conn = select_model(getattr(request.app.state, "managed_connection", None))
    if conn is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")

    if conn.source == "managed":
        limiter = request.app.state.managed_limiter
        if not limiter.allow(_MANAGED_LIMITER_KEY, time.monotonic()):
            raise HTTPException(status_code=429, detail="managed_tier_rate_limited")

    budget = request.app.state.token_budget
    if budget.remaining(project.workspace_id, conn.daily_token_budget) <= 0:
        raise HTTPException(status_code=429, detail="daily_token_budget_exceeded")
    return conn


@router.post("/projects/{project_id}/generate/{stage}")
async def generate(
    project_id: str,
    stage: StageKind,
    body: GenerateRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StreamingResponse:
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    conn = _resolve_model(request, project)
    budget = request.app.state.token_budget

    requirement: Requirement | None = None
    spec: SpecDocument | None = None
    if stage == "plan":
        requirement = repo.get_latest_requirement(project_id)
        if requirement is None:
            raise HTTPException(status_code=409, detail="requirement_required")
    elif stage == "tasks":
        spec = repo.get_latest_spec_document(project_id)
        if spec is None:
            raise HTTPException(status_code=409, detail="spec_document_required")

    secret_store = request.app.state.secret_store
    api_key = secret_store.decrypt(conn.secret_ref)
    provider = getattr(request.app.state, "generation_provider", None) or HttpGenerationProvider()

    context = ""
    if stage == "constitution":
        # Policy Scope injection (C5): server-side only, keyed off
        # project.policy_scope — never client-composed input. Full template
        # bodies + custom text, since the constitution is the one stage that
        # had zero context before this feature and is the authoritative
        # embodiment of the chosen scope.
        context = _policy_block(project, stage)
    elif stage in ("specify", "plan"):
        # Full-text injection, not embedding-retrieval (docs/superpowers/
        # specs/2026-07-25-cloud-planner-ui-design.md): a project realistically
        # has one or two PRD documents, so giving the model everything beats
        # top-8 semantic chunks for something plan-critical — and it works
        # with the managed (chat-only, no embed_model) connection, unlike the
        # retrieval path it replaces.
        #
        # Layered budget: (1) compact policy summary, (2) the generated
        # constitution (capped — this also fixes cloud's pre-existing gap
        # where specify/plan/tasks never saw the constitution at all,
        # applying to scope-less projects too), (3) PRDs get whatever's left
        # of the 40k document budget.
        segments: list[str] = []
        policy_summary = _policy_block(project, stage)
        used = 0
        if policy_summary:
            segments.append(policy_summary)
            used += len(policy_summary)
        constitution_doc = repo.get_stage_document(project_id, "constitution")
        if constitution_doc and constitution_doc.content.strip():
            constitution_text = _truncate_with_marker(constitution_doc.content, 12_000)
            segments.append(f"[constitution]\n{constitution_text}")
            used += len(constitution_text)
        remaining_budget = max(_DOCUMENT_CONTEXT_BUDGET - used, 0)
        doc_context = _assemble_document_context(
            repo.list_documents(project_id), budget=remaining_budget
        )
        if doc_context:
            segments.append(doc_context)
        context = "\n\n".join(segments)
    elif stage == "tasks":
        # tasks grounds on the approved plan first (unchanged), then the
        # constitution (capped tighter than specify/plan's — tasks needs less
        # of it), then the policy summary.
        segments = [f"[spec_documents:{spec.id}]\n{spec.content}"]
        constitution_doc = repo.get_stage_document(project_id, "constitution")
        if constitution_doc and constitution_doc.content.strip():
            constitution_text = _truncate_with_marker(constitution_doc.content, 8_000)
            segments.append(f"[constitution]\n{constitution_text}")
        policy_summary = _policy_block(project, stage)
        if policy_summary:
            segments.append(policy_summary)
        context = "\n\n".join(segments)

    system_prompt = driver_prompt(stage)
    user_content = f"{body.user_input}\n\nCONTEXT:\n{context}" if context else body.user_input

    run = repo.create_generation_run(
        GenerationRun(
            workspace_id=project.workspace_id,
            project_id=project_id,
            stage=stage,
            model_source=conn.source,
            model=conn.model,
        )
    )

    max_tokens = request.app.state.settings.managed_model_max_tokens

    async def stream():
        parts: list[str] = []
        # Written by the provider's on_finish callback once the stream ends —
        # a single-slot list because a nested function can't rebind a name in
        # the enclosing async generator's scope without `nonlocal`, and the
        # callback is defined here to stay next to what reads it.
        finish: list[str | None] = [None]
        try:
            async for delta in provider.stream(
                system_prompt,
                user_content,
                conn.model,
                api_key,
                conn.base_url,
                max_tokens=max_tokens,
                on_finish=lambda reason: finish.__setitem__(0, reason),
            ):
                parts.append(delta)
                yield f"data: {json.dumps({'delta': delta})}\n\n"
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            retryable = status == 429
            if status == 429 and conn.source == "managed":
                message = "managed tier busy, try again or connect your own key"
            else:
                message = f"model provider error ({status})"
            repo.update_generation_run(
                run.id, status="failed", prompt_tokens=0, completion_tokens=0
            )
            error_payload = {"error": message, "retryable": retryable}
            yield f"event: error\ndata: {json.dumps(error_payload)}\n\n"
            return
        raw = "".join(parts)
        truncated = finish[0] == "length"

        prompt_tokens = estimate_tokens(system_prompt) + estimate_tokens(user_content)
        completion_tokens = estimate_tokens(raw)
        budget.record(project.workspace_id, prompt_tokens + completion_tokens)

        try:
            result = parse_stage_output(stage, body.user_input, raw)
        except GenerationError as exc:
            repo.update_generation_run(
                run.id,
                status="failed",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
            yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"
            return

        payload: dict = {
            "stage": stage,
            "title": result.title,
            "content": result.content,
            # The document is real and persisted either way; `truncated` tells
            # the Planner to say so instead of presenting a half-written spec
            # as finished work.
            "truncated": truncated,
        }

        # One call does the raw-markdown save, the graph projection and the RAG
        # enqueues, shared with the manual-edit route (app/generation/
        # stage_apply.py, plan 0018 M1). The save happens first inside it, so
        # generated text the graph rejects — most visibly a `tasks` stage whose
        # checklist doesn't parse — is still waiting in the editor when the user
        # reopens the project.
        applied: StageApplyResult | None = None
        try:
            applied = apply_stage_content(
                repo,
                project,
                stage,
                result.content,
                source="generated",
                actor_id=user.id,
                app=request.app,
                user_input=body.user_input,
            )
        except Exception:
            # The side store is unreachable. Nothing is written — neither the
            # document nor the graph — which is the point: half-applying a
            # generation is the inconsistency plan 0018 exists to remove. The
            # client is told (`saved: false`) so it can warn that this text
            # won't survive a reload rather than implying it will.
            logger.exception(
                "auto-save of stage document failed for project=%s stage=%s",
                project_id,
                stage,
            )

        saved = applied is not None
        payload["saved"] = saved
        payload["projection"] = applied.projection if applied is not None else "failed"
        if applied is not None and applied.document_updated_at is not None:
            payload["updated_at"] = applied.document_updated_at

        if applied is None or applied.projection == "failed":
            repo.update_generation_run(
                run.id,
                status="failed",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
            message = (
                applied.error
                if applied is not None and applied.error
                else "the generated document could not be applied to the project graph"
            )
            error_payload = {"error": message, "draft_saved": saved, "truncated": truncated}
            if truncated:
                error_payload["error"] = (
                    f"{message} — the model stopped at its output limit, so the document is "
                    "incomplete. The partial draft was kept; try generating again."
                )
            yield f"event: error\ndata: {json.dumps(error_payload)}\n\n"
            return

        if stage == "specify" and applied.entity_ids:
            payload["requirement_id"] = applied.entity_ids[0]
        elif stage == "plan" and applied.entity_ids:
            payload["spec_document_id"] = applied.entity_ids[0]
        elif stage == "tasks":
            payload["task_count"] = applied.task_count
            payload["retired_count"] = applied.retired_count

        repo.update_generation_run(
            run.id,
            status="truncated" if truncated else "succeeded",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        if truncated:
            logger.warning(
                "generation hit the completion cap: project=%s stage=%s model=%s max_tokens=%s",
                project_id,
                stage,
                conn.model,
                max_tokens,
            )
        yield f"event: done\ndata: {json.dumps(payload)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


class PrefillField(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=200)
    hint: str = Field(default="", max_length=400)


class PrefillRequest(BaseModel):
    """The Planner's own form definition, sent per request — see
    app/generation/prefill.py for why the field list isn't duplicated here."""

    fields: list[PrefillField] = Field(min_length=1, max_length=24)


class PrefillResponse(BaseModel):
    fields: dict[str, str]
    # What the draft was read from, so the Planner can say so rather than
    # presenting drafted text as if it came from nowhere.
    sources: list[str]


@router.post("/projects/{project_id}/prefill/{stage}", response_model=PrefillResponse)
async def prefill(
    project_id: str,
    stage: Literal["specify", "plan"],
    body: PrefillRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> PrefillResponse:
    """Draft a stage's intake form from the uploaded PRD (and, for `plan`, the
    specification already written). Read-only with respect to the graph and
    the stage documents: the author reviews and edits the draft, then runs the
    stage itself as before."""
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, stage, user)
    conn = _resolve_model(request, project)

    documents = repo.list_documents(project_id)
    context = _assemble_document_context(documents)
    sources = [d.title for d in documents if d.extracted_text]

    if stage == "plan":
        # A PRD rarely names a language or a datastore, but the specification
        # written from it carries the scope the technical fields hang off.
        spec_doc = repo.get_stage_document(project_id, "specify")
        if spec_doc and spec_doc.content.strip():
            context = f"{context}\n\n[specification]\n{spec_doc.content}".strip()
            sources.append("the specification")

    if not context.strip():
        raise HTTPException(status_code=409, detail="no_source_material")

    fields = [f.model_dump() for f in body.fields]
    user_content = build_prefill_prompt(fields, context)

    secret_store = request.app.state.secret_store
    api_key = secret_store.decrypt(conn.secret_ref)
    provider = getattr(request.app.state, "generation_provider", None) or HttpGenerationProvider()

    run = repo.create_generation_run(
        GenerationRun(
            workspace_id=project.workspace_id,
            project_id=project_id,
            stage=f"prefill:{stage}",
            model_source=conn.source,
            model=conn.model,
        )
    )

    parts: list[str] = []
    try:
        async for delta in provider.stream(
            PREFILL_SYSTEM_PROMPT,
            user_content,
            conn.model,
            api_key,
            conn.base_url,
            max_tokens=request.app.state.settings.managed_model_max_tokens,
        ):
            parts.append(delta)
    except httpx.HTTPStatusError as exc:
        repo.update_generation_run(run.id, status="failed", prompt_tokens=0, completion_tokens=0)
        status = exc.response.status_code
        raise HTTPException(
            status_code=429 if status == 429 else 502,
            detail="managed_tier_rate_limited" if status == 429 else "model_provider_error",
        ) from exc

    raw = "".join(parts)
    prompt_tokens = estimate_tokens(PREFILL_SYSTEM_PROMPT) + estimate_tokens(user_content)
    completion_tokens = estimate_tokens(raw)
    request.app.state.token_budget.record(project.workspace_id, prompt_tokens + completion_tokens)

    drafted = parse_prefill(raw, fields)
    if drafted is None:
        repo.update_generation_run(
            run.id,
            status="failed",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        # Nothing was written and nothing is half-applied — the form is exactly
        # as the author left it, so this is safe to simply retry.
        raise HTTPException(status_code=502, detail="prefill_unparseable")

    repo.update_generation_run(
        run.id,
        status="succeeded",
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
    return PrefillResponse(fields=drafted, sources=sources)


# Total characters of document text injected into a single specify/plan
# prompt. Mirrors the budget-capping shape of apps/engine's repoSnapshot()
# (apps/engine/src/routes/projects.ts) — same problem (bound an LLM prompt
# by a fixed character budget across N files), same "truncate the tail, note
# it was truncated" approach.
_DOCUMENT_CONTEXT_BUDGET = 40_000


def _assemble_document_context(documents: list, budget: int = _DOCUMENT_CONTEXT_BUDGET) -> str:
    parts = []
    remaining = budget
    truncated = False
    for doc in documents:
        if not doc.extracted_text:
            continue
        if remaining <= 0:
            truncated = True
            break
        text = doc.extracted_text[:remaining]
        if len(text) < len(doc.extracted_text):
            truncated = True
        remaining -= len(text)
        parts.append(f"[document:{doc.title}]\n{text}")
    if truncated:
        parts.append("(remaining document content omitted — context budget reached)")
    return "\n\n".join(parts)


# Visible marker for every truncation point in server-composed context, so a
# capped section (constitution excerpt, policy templates, PRDs) never reads
# as complete when it isn't.
_TRUNCATION_MARKER = "\n\n...[truncated]"


def _truncate_with_marker(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = max(max_chars - len(_TRUNCATION_MARKER), 0)
    return text[:cut] + _TRUNCATION_MARKER


def _policy_block(project: Project, stage: str) -> str:
    """Policy Scope injection (C5), keyed off `project.policy_scope` —
    server-side only, never client-composed input. Returns "" when the scope
    is empty/None, so a legacy (scope-less) project's prompt is
    byte-identical to before this feature existed.

    `constitution` gets the full template bodies + custom text (the
    authoritative, reviewed embodiment of the scope); every later stage gets
    the compact summary instead, since they also receive the generated
    constitution itself (see the caller) — the summary is a hedge against a
    constitution generated *before* scope selection, not the primary source.
    """
    scope = project.policy_scope
    if scope is None or (not scope.selected and not scope.custom_text.strip()):
        return ""
    if stage == "constitution":
        return render_policy_context(scope, max_chars=30_000)
    return render_policy_summary(scope, max_chars=1_500)
