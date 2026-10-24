"""POST /workspaces/{id}/ask (plan 0033 task 20): ask about the workspace.

The model sees only `facts_to_text(WorkspaceFacts)`, never document text,
discussion bodies or decision snapshots. Facts always stream first, so the
answer exists even with no model connection or an exhausted budget.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api._guards import require_workspace
from app.api.me import collect_my_decisions
from app.api.overview import build_overview
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import GenerationRun
from app.overview.facts import compute_workspace_facts, facts_to_text
from app.rag.budget import estimate_tokens
from app.rag.chat import HttpChatProvider
from app.rag.models import resolve_assistant_models

router = APIRouter(tags=["ask"])
log = logging.getLogger(__name__)

ASK_SYSTEM_PROMPT = (
    "You answer questions about a software workspace using only the facts provided. "
    "If the facts do not contain the answer, say what you do know and what you cannot see. "
    "Never invent people, projects or numbers."
)


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


@router.post("/workspaces/{workspace_id}/ask")
async def ask_workspace(
    workspace_id: str,
    body: AskRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StreamingResponse:
    require_workspace(repo, workspace_id, user)
    overview = build_overview(repo, workspace_id, user)
    mine = [i.decision for i in collect_my_decisions(repo, user, workspace_id)]
    facts = compute_workspace_facts(overview, mine)
    context = facts_to_text(facts)

    managed_chat = getattr(request.app.state, "managed_connection", None)
    models = resolve_assistant_models(repo, workspace_id, managed_chat, None)
    budget = request.app.state.token_budget
    chat_provider = getattr(request.app.state, "chat_provider", None) or HttpChatProvider()
    conn = models.chat if models is not None else None
    exhausted = conn is not None and budget.remaining(workspace_id, conn.daily_token_budget) <= 0
    api_key = request.app.state.secret_store.decrypt(conn.secret_ref) if conn else None

    async def stream():
        yield f"event: facts\ndata: {facts.model_dump_json()}\n\n"
        if conn is not None and not exhausted:
            run = repo.create_generation_run(
                GenerationRun(
                    workspace_id=workspace_id,
                    project_id=None,
                    stage="ask:workspace",
                    model_source=conn.source,
                    model=conn.model,
                )
            )
            parts: list[str] = []
            status = "failed"
            try:
                async for delta in chat_provider.stream_chat(
                    context,
                    body.question,
                    conn.model,
                    api_key,
                    conn.base_url,
                    system_prompt=ASK_SYSTEM_PROMPT,
                ):
                    parts.append(delta)
                    yield f"data: {json.dumps({'delta': delta})}\n\n"
                status = "succeeded"
            except Exception:
                log.exception("ask:workspace provider failed")
            finally:
                # Runs on client disconnect too (CancelledError), so tokens
                # already spent are still recorded and the run is closed.
                prompt_tokens = estimate_tokens(context + body.question)
                completion_tokens = estimate_tokens("".join(parts)) if parts else 0
                budget.record(workspace_id, prompt_tokens + completion_tokens)
                repo.update_generation_run(
                    run.id,
                    status=status,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                )
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
