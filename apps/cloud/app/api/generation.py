"""Stage generation endpoints (M1, plan 0007): the cloud-side Spec Kit path
for business users with no desktop app to run the engine's own `runStage()`
(ADR 0013, plan 0007's "surface decision"). Same auth/membership/rate-limit/
budget stack as the RAG assistant (app/api/assistant.py) — a parallel,
self-contained generation path, not a relay to a running local engine.

Model selection (`select_model`) prefers the workspace's BYO connection,
falling back to the platform-operated managed Typhoon connection (M2) when
the workspace has none configured. The stage routing table (which stages
default to managed vs BYO, per-workspace/project overrides) is M3.

Persistence mirrors what the engine's own stage routes already do
(apps/engine/src/routes/projects.ts): `specify` creates a Requirement,
`plan` creates a SpecDocument against the latest requirement, `tasks`
parses the checklist into Task rows against the latest spec document.
`constitution` has no graph entity to land on (it's project-level
governance text, not a per-requirement artifact) — it streams back to the
caller and is recorded in `generation_runs`, but isn't itself persisted to
the graph in this milestone.
"""

from __future__ import annotations

import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.generation.parsing import parse_task_lines
from app.generation.prompts import StageKind, driver_prompt
from app.generation.routing import select_model
from app.generation.service import GenerationError, HttpGenerationProvider, parse_stage_output
from app.models.schemas import (
    AcceptanceCriterion,
    GenerateRequest,
    GenerationRun,
    GraphUpsertRequest,
    Requirement,
    RequirementStatus,
    SpecDocument,
    Task,
)
from app.rag.budget import estimate_tokens
from app.rag.embedder import HttpEmbeddingProvider

logger = logging.getLogger("promptconnext.generation")
router = APIRouter(tags=["generation"])

# Key for the managed source's *global* rate limiter (app.state.managed_limiter)
# — one shared free Typhoon key, so this is deliberately not per-workspace.
_MANAGED_LIMITER_KEY = "managed:typhoon"


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

    managed_connection = getattr(request.app.state, "managed_connection", None)
    conn = select_model(repo, project.workspace_id, project_id, stage, managed_connection)
    if conn is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")

    if conn.source == "managed":
        managed_limiter = request.app.state.managed_limiter
        if not managed_limiter.allow(_MANAGED_LIMITER_KEY, time.monotonic()):
            raise HTTPException(status_code=429, detail="managed_tier_rate_limited")

    budget = request.app.state.token_budget
    if budget.remaining(project.workspace_id, conn.daily_token_budget) <= 0:
        raise HTTPException(status_code=429, detail="daily_token_budget_exceeded")

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
    embedder = getattr(request.app.state, "embedding_provider", None) or HttpEmbeddingProvider()
    provider = getattr(request.app.state, "generation_provider", None) or HttpGenerationProvider()

    context = ""
    if stage in ("specify", "plan") and conn.embed_model:
        # The M0 payoff: ground on the project's uploaded documents (and
        # every other embedded node type) via the same membership-scoped
        # retrieval assistant.chat uses. Skipped, not errored, when the
        # resolved connection can't embed (the managed tier is chat-only in
        # this pilot) — same "skip when ungrounded" shape the embed queue
        # uses for a missing BYO connection.
        [query_embedding] = await embedder.embed(
            [body.user_input], conn.embed_model, api_key, conn.base_url
        )
        hits = repo.vector_search(project.workspace_id, project_id, query_embedding, top_k=8)
        context = _assemble_retrieval_context(repo, project_id, hits)
    elif stage == "tasks":
        # tasks grounds on the approved plan, not raw uploads.
        context = f"[spec_documents:{spec.id}]\n{spec.content}"

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

    async def stream():
        parts: list[str] = []
        try:
            async for delta in provider.stream(
                system_prompt, user_content, conn.model, api_key, conn.base_url
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

        payload: dict = {"stage": stage, "title": result.title, "content": result.content}
        try:
            if stage == "specify":
                payload["requirement_id"] = _persist_requirement(repo, project_id, result, body)
            elif stage == "plan":
                payload["spec_document_id"] = _persist_spec_document(
                    repo, project, requirement, result
                )
            elif stage == "tasks":
                payload["task_count"] = _persist_tasks(repo, project, spec, result)
        except GenerationError as exc:
            repo.update_generation_run(
                run.id,
                status="failed",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
            yield f"event: error\ndata: {json.dumps({'error': str(exc)})}\n\n"
            return

        repo.update_generation_run(
            run.id,
            status="succeeded",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        yield f"event: done\ndata: {json.dumps(payload)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


def _assemble_retrieval_context(repo: Repository, project_id: str, hits: list) -> str:
    parts = []
    for h in hits:
        label = f"{h.node_type}:{h.node_id}"
        if h.node_type == "documents":
            doc = repo.get_document(project_id, h.node_id)
            if doc is not None:
                label = f"document:{doc.title}"
        parts.append(f"[{label}#{h.chunk_index}]\n{h.content}")
    return "\n\n".join(parts)


def _persist_requirement(repo: Repository, project_id: str, result, body: GenerateRequest) -> str:
    requirement = Requirement(
        project_id=project_id,
        title=result.title,
        description=body.user_input,
        status=RequirementStatus.draft,
    )
    repo.upsert_graph(project_id, GraphUpsertRequest(requirements=[requirement]), source="pz")
    return requirement.id


def _persist_spec_document(repo: Repository, project, requirement: Requirement, result) -> str:
    spec_document = SpecDocument(
        project_id=project.id,
        requirement_id=requirement.id,
        content=result.content,
        version=1,
    )
    repo.upsert_graph(project.id, GraphUpsertRequest(spec_documents=[spec_document]), source="pz")
    return spec_document.id


def _persist_tasks(repo: Repository, project, spec: SpecDocument, result) -> int:
    parsed = parse_task_lines(result.content)
    if not parsed:
        raise GenerationError("tasks document contained no parseable '- [ ] T###' checklist lines")
    tasks = [
        Task(
            project_id=project.id,
            spec_id=spec.id,
            title=t["title"],
            acceptance_criteria=[AcceptanceCriterion(text=t["title"])],
            feature_tag=f"{t['ref']} [P]" if t["parallel"] else t["ref"],
        )
        for t in parsed
    ]
    repo.upsert_graph(project.id, GraphUpsertRequest(tasks=tasks), source="pz")
    return len(tasks)
