"""RAG assistant API: workspace model connection + project chat.

Endpoints:
  POST /workspaces/{id}/model-connection   admin — configure workspace-BYO model
  POST /projects/{id}/assistant/chat       member — SSE-streamed, cited answer
  POST /projects/{id}/assistant/reindex    admin — backfill existing graph nodes

Retrieval is membership-scoped before similarity (ADR 0011): `require_project`
gates the caller to the project's workspace, and `vector_search` additionally
filters by that same workspace_id/project_id before ranking.

Chat (M10): the question is classified (app/rag/classify.py) before any
retrieval. Lineage/status questions are answered from an exact graph walk
(app/rag/lineage.py, SQL-backed `get_graph` — no embeddings); content
questions use the M9 vector-search path; mixed questions use both. The graph
walk's facts are exact by construction — sent to the client as their own
`facts` SSE event, ahead of the model's narration, so status/progress
questions carry data a test can assert on directly.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api._guards import require_admin, require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    ChatRequest,
    Citation,
    LineageFacts,
    ModelConnectionCreate,
    ModelConnectionOut,
)
from app.rag.budget import estimate_tokens
from app.rag.chat import HttpChatProvider
from app.rag.classify import classify_question
from app.rag.embedder import HttpEmbeddingProvider
from app.rag.lineage import compute_facts, facts_to_text, resolve_target
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

logger = logging.getLogger("promptzone.assistant")
router = APIRouter(tags=["assistant"])


@router.post("/workspaces/{workspace_id}/model-connection", response_model=ModelConnectionOut)
async def set_model_connection(
    workspace_id: str,
    body: ModelConnectionCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ModelConnectionOut:
    require_admin(repo, workspace_id, user)
    settings = request.app.state.settings
    settings.require_rag()
    if not body.base_url.startswith("https://"):
        raise HTTPException(status_code=422, detail="base_url_must_be_https")

    embedder = getattr(request.app.state, "embedding_provider", None) or HttpEmbeddingProvider()
    try:
        await embedder.embed(["healthcheck"], body.embed_model, body.api_key, body.base_url)
    except Exception as exc:  # noqa: BLE001 - any failure means the key/URL don't work
        logger.warning("model connection health check failed: %s", exc)
        raise HTTPException(
            status_code=400, detail="model_connection_health_check_failed"
        ) from exc

    secret_store = request.app.state.secret_store
    conn = repo.upsert_model_connection(
        workspace_id=workspace_id,
        provider=body.provider,
        base_url=body.base_url,
        model=body.model,
        embed_model=body.embed_model,
        embed_dim=body.embed_dim,
        secret_ref=secret_store.encrypt(body.api_key),
        daily_token_budget=body.daily_token_budget,
        created_by=user.id,
    )
    return ModelConnectionOut(**conn.model_dump(exclude={"secret_ref"}))


@router.post("/projects/{project_id}/assistant/reindex")
def reindex_project(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> dict:
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    graph = repo.get_graph(project_id)  # bootstrap pull: live rows only
    enqueued = 0
    for node_type in RAG_NODE_TYPES:
        for item in getattr(graph, node_type):
            enqueue(request.app, EmbedJob(project.workspace_id, project_id, node_type, item.id))
            enqueued += 1
    return {"enqueued": enqueued}


@router.post("/projects/{project_id}/assistant/chat")
async def chat(
    project_id: str,
    body: ChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StreamingResponse:
    project = require_project(repo, project_id, user)
    conn = repo.get_model_connection(project.workspace_id)
    if conn is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")

    budget = request.app.state.token_budget
    if budget.remaining(project.workspace_id, conn.daily_token_budget) <= 0:
        raise HTTPException(status_code=429, detail="daily_token_budget_exceeded")

    secret_store = request.app.state.secret_store
    api_key = secret_store.decrypt(conn.secret_ref)
    embedder = getattr(request.app.state, "embedding_provider", None) or HttpEmbeddingProvider()
    chat_provider = getattr(request.app.state, "chat_provider", None) or HttpChatProvider()

    classification = classify_question(body.question)

    facts = None
    facts_citation = None
    if classification in ("lineage", "mixed"):
        # Exact graph walk — same bootstrap pull reindex_project uses, no
        # embeddings involved. Membership was already gated by
        # require_project() above, so this new code path inherits that guard.
        graph = repo.get_graph(project_id)
        target = resolve_target(graph, body.question)
        facts = compute_facts(graph, target)
        if facts.node_type and facts.node_id:
            facts_citation = Citation(
                node_type=facts.node_type, node_id=facts.node_id, chunk_index=0, source="graph"
            )

    hits: list = []
    if classification in ("content", "mixed"):
        [query_embedding] = await embedder.embed(
            [body.question], conn.embed_model, api_key, conn.base_url
        )
        hits = repo.vector_search(project.workspace_id, project_id, query_embedding, top_k=8)

    context = _assemble_context(facts, hits)

    async def stream():
        if facts is not None:
            yield f"event: facts\ndata: {facts.model_dump_json()}\n\n"

        answer_parts: list[str] = []
        async for delta in chat_provider.stream_chat(
            context, body.question, conn.model, api_key, conn.base_url
        ):
            answer_parts.append(delta)
            yield f"data: {json.dumps({'delta': delta})}\n\n"
        answer = "".join(answer_parts)
        budget.record(
            project.workspace_id, estimate_tokens(context) + estimate_tokens(answer)
        )

        citations = [
            Citation(
                node_type=h.node_type, node_id=h.node_id, chunk_index=h.chunk_index
            ).model_dump()
            for h in hits
        ]
        if facts_citation is not None:
            citations.append(facts_citation.model_dump())
        yield f"event: citations\ndata: {json.dumps({'citations': citations})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


def _assemble_context(facts: LineageFacts | None, hits: list) -> str:
    parts = []
    if facts is not None:
        parts.append(f"GRAPH FACTS (exact, from the project graph):\n{facts_to_text(facts)}")
    if hits:
        parts.append(
            "\n\n".join(f"[{h.node_type}:{h.node_id}#{h.chunk_index}]\n{h.content}" for h in hits)
        )
    if not parts:
        return "(no matching project artifacts found)"
    return "\n\n".join(parts)
