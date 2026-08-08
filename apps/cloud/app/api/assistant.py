"""RAG assistant API: workspace model connection + project chat.

Endpoints:
  GET  /workspaces/{id}/model-connection      admin — non-secret status
  POST /workspaces/{id}/model-connection      admin — configure workspace-BYO model
  POST /projects/{id}/assistant/chat          member — SSE-streamed, cited answer
  POST /projects/{id}/assistant/reindex       admin — backfill existing graph nodes
  GET  /projects/{id}/assistant/index-status  member — chunk count / embed model,
                                               the completion signal reindex itself
                                               never had

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

Code retrieval (M11): a content/mixed question also runs `code_vector_search`
against the same query embedding (no separate per-workspace code-embedding
model in v1). Unlike every other hit type, a code hit's `content` is never
stored — the matching line range is fetched fresh from GitHub for this
request only, using the workspace's own PAT (ADR 0017 amendment), and
discarded once the answer streams (ADR 0011: no source code at rest).

Keyless (plan 0008 M1): `resolve_assistant_models` (app/rag/models.py)
resolves BYO-then-managed the same way generation's `select_model` does, but
returns a *pair* — chat + a possibly-`None` embed connection, since the
managed Typhoon chat model has no embeddings of its own. A project's chunks
must stay embedded with one model (`pz_rag_chunks.embedding` is fixed-width);
`get_project_embed_model` catches a switch and asks for a reindex instead of
silently comparing incompatible vectors.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api._guards import require_admin, require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.integrations.github_auth import resolve_token
from app.models.schemas import (
    ChatRequest,
    Citation,
    CodeChunkHit,
    IndexStatusOut,
    LineageFacts,
    ModelConnectionCreate,
    ModelConnectionOut,
    ModelConnectionStatusOut,
)
from app.rag.backfill import (
    count_indexable_nodes,
    enqueue_project_backfill,
    enqueue_workspace_backfill,
)
from app.rag.budget import estimate_tokens
from app.rag.chat import HttpChatProvider
from app.rag.classify import classify_question
from app.rag.embedder import HttpEmbeddingProvider
from app.rag.lineage import compute_facts, facts_to_text, resolve_target
from app.rag.models import resolve_assistant_models

logger = logging.getLogger("promptconnext.assistant")
router = APIRouter(tags=["assistant"])


@router.get(
    "/workspaces/{workspace_id}/model-connection", response_model=ModelConnectionStatusOut
)
def get_model_connection(
    workspace_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ModelConnectionStatusOut:
    """Non-secret view of the workspace's assistant model, for the settings UI.

    Reports the *resolved* sources rather than only whether a BYO row exists,
    so the UI can tell "no connection, but the managed tier covers it" apart
    from "no connection and nothing else either" — the second means the
    assistant cannot answer at all, which is worth saying out loud.
    """
    require_admin(repo, workspace_id, user)
    conn = repo.get_model_connection(workspace_id)
    models = resolve_assistant_models(
        repo,
        workspace_id,
        getattr(request.app.state, "managed_connection", None),
        getattr(request.app.state, "managed_embed_connection", None),
    )
    if models is None:
        chat_source, embed_source = "none", "none"
    else:
        chat_source = models.chat.source
        embed_source = models.embed.source if models.embed is not None else "none"
    return ModelConnectionStatusOut(
        configured=conn is not None,
        connection=(
            ModelConnectionOut(**conn.model_dump(exclude={"secret_ref"}))
            if conn is not None
            else None
        ),
        chat_source=chat_source,
        embed_source=embed_source,
    )


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
        await embedder.embed(
            ["healthcheck"], body.embed_model, body.api_key, body.base_url, body.embed_dim
        )
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

    # Backfill: content synced while no connection existed (or an earlier
    # one was misconfigured) sat in the graph/documents stores unembedded —
    # app/rag/queue.py's "no model connection" branch drops those jobs
    # rather than deferring them, so nothing catches up on its own once a
    # connection finally resolves. Fan out across every project in the
    # workspace now, rather than waiting on an admin to press reindex on
    # each one by hand.
    enqueue_workspace_backfill(request.app, repo, workspace_id)

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
    enqueued = enqueue_project_backfill(request.app, repo, project)
    return {"enqueued": enqueued}


@router.get(
    "/projects/{project_id}/assistant/index-status", response_model=IndexStatusOut
)
def get_index_status(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> IndexStatusOut:
    """The completion signal `POST .../reindex` never had: that endpoint
    returns `{"enqueued": N}` the instant jobs are queued, with no way to
    tell "queued" apart from "indexed" or "silently dropped" (e.g. a reindex
    run while no model connection was configured — app/rag/queue.py's
    `_process_job` discards a job outright rather than deferring it).

    Membership-gated like chat, not admin-only like reindex itself — seeing
    whether the assistant has anything to work with isn't privileged, and
    the panel that will render this is visible to every member even though
    only an admin can press the reindex button.
    """
    project = require_project(repo, project_id, user)
    return IndexStatusOut(
        indexed_chunks=repo.count_project_rag_chunks(project.workspace_id, project_id),
        indexable_nodes=count_indexable_nodes(repo, project),
        embed_model=repo.get_project_embed_model(project.workspace_id, project_id),
    )


@router.post("/projects/{project_id}/assistant/chat")
async def chat(
    project_id: str,
    body: ChatRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StreamingResponse:
    project = require_project(repo, project_id, user)

    managed_chat = getattr(request.app.state, "managed_connection", None)
    managed_embed = getattr(request.app.state, "managed_embed_connection", None)
    models = resolve_assistant_models(repo, project.workspace_id, managed_chat, managed_embed)
    if models is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")
    conn = models.chat

    budget = request.app.state.token_budget

    secret_store = request.app.state.secret_store
    chat_api_key = secret_store.decrypt(conn.secret_ref)
    embedder = getattr(request.app.state, "embedding_provider", None) or HttpEmbeddingProvider()
    chat_provider = getattr(request.app.state, "chat_provider", None) or HttpChatProvider()

    classification = classify_question(body.question)

    facts = None
    facts_citation = None
    if classification in ("lineage", "mixed"):
        # Exact graph walk — same bootstrap pull reindex_project uses, no
        # embeddings involved, so it always runs regardless of budget state.
        # Membership was already gated by require_project() above, so this
        # new code path inherits that guard.
        graph = repo.get_graph(project_id)
        target = resolve_target(graph, body.question)
        facts = compute_facts(graph, target)
        if facts.node_type and facts.node_id:
            facts_citation = Citation(
                node_type=facts.node_type, node_id=facts.node_id, chunk_index=0, source="graph"
            )

    # Budget check moves here (after the zero-cost graph walk, before any
    # further token spend): a lineage/mixed question that already has facts
    # can still be served — just without the LLM narration — while a
    # content-only question with nothing to fall back on still hard-429s.
    budget_exhausted = budget.remaining(project.workspace_id, conn.daily_token_budget) <= 0
    if budget_exhausted and facts is None:
        raise HTTPException(status_code=429, detail="daily_token_budget_exceeded")

    hits: list = []
    code_hits: list[CodeChunkHit] = []
    if not budget_exhausted and classification in ("content", "mixed") and models.embed is not None:
        embed_conn = models.embed
        existing_embed_model = repo.get_project_embed_model(project.workspace_id, project_id)
        if existing_embed_model and existing_embed_model != embed_conn.embed_model:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"embed_model_mismatch: this project's chunks were embedded with "
                    f"'{existing_embed_model}'; reindex required before switching to "
                    f"'{embed_conn.embed_model}' "
                    f"(POST /projects/{project_id}/assistant/reindex)"
                ),
            )
        embed_api_key = secret_store.decrypt(embed_conn.secret_ref)
        [query_embedding] = await embedder.embed(
            [body.question],
            embed_conn.embed_model,
            embed_api_key,
            embed_conn.base_url,
            embed_conn.embed_dim,
        )
        hits = repo.vector_search(project.workspace_id, project_id, query_embedding, top_k=8)
        code_hits = repo.code_vector_search(
            project.workspace_id, project_id, query_embedding, top_k=8
        )

    code_snippets, code_citations = await _fetch_code_context(request.app, repo, project, code_hits)

    context = _assemble_context(facts, hits, code_snippets)

    async def stream():
        if facts is not None:
            yield f"event: facts\ndata: {facts.model_dump_json()}\n\n"

        # Retrieval transparency: an ungrounded content answer is
        # indistinguishable in its text from one the corpus genuinely cannot
        # answer, so say which it was. `no_embed_model` is an operator
        # problem (Typhoon is chat-only; a separate embedding model must be
        # configured); `no_indexed_content` is fixable by reindexing.
        if not budget_exhausted and classification in ("content", "mixed"):
            reason = None
            if models.embed is None:
                reason = "no_embed_model"
            elif not hits and not code_hits:
                reason = "no_indexed_content"
            if reason is not None:
                yield (
                    "event: retrieval\ndata: "
                    + json.dumps({"grounded": False, "reason": reason})
                    + "\n\n"
                )

        if budget_exhausted:
            # facts must be non-None here (otherwise the 429 above already
            # fired) — degrade to lineage-only rather than spending more
            # tokens on embed+vector-search or the LLM call.
            yield (
                "data: "
                + json.dumps(
                    {
                        "delta": (
                            "Daily assistant budget reached — showing lineage facts "
                            "only. Ask again tomorrow or connect more model budget."
                        )
                    }
                )
                + "\n\n"
            )
        else:
            answer_parts: list[str] = []
            async for delta in chat_provider.stream_chat(
                context, body.question, conn.model, chat_api_key, conn.base_url
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
        citations.extend(c.model_dump() for c in code_citations)
        if facts_citation is not None:
            citations.append(facts_citation.model_dump())
        yield f"event: citations\ndata: {json.dumps({'citations': citations})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


async def _fetch_code_context(
    app, repo: Repository, project, code_hits: list[CodeChunkHit]
) -> tuple[list[str], list[Citation]]:
    """Fetch-on-demand: resolve the workspace's PAT and pull just the matched
    line range fresh from GitHub for *this request only*. The fetched text
    (`full`, `snippet`) never reaches any repository write — it's a local
    variable that goes out of scope when this function returns (ADR 0011: no
    source code at rest). Silently yields nothing if GitHub isn't configured
    for this workspace — a content question must still work without it.
    """
    if not code_hits:
        return [], []
    workspace = repo.get_workspace(project.workspace_id)
    resolved = resolve_token(app, workspace)
    if resolved is None:
        return [], []
    token, _ = resolved

    github_client = app.state.github_client

    snippets: list[str] = []
    citations: list[Citation] = []
    fetched: dict[tuple[str, str, str], str] = {}
    for hit in code_hits:
        key = (hit.repo, hit.path, hit.sha)
        if key not in fetched:
            fetched[key] = await github_client.fetch_file_content(
                token, hit.repo, hit.path, hit.sha
            )
        full = fetched[key]
        snippet = "\n".join(full.splitlines()[hit.start_line - 1 : hit.end_line])
        snippets.append(f"[code:{hit.repo}/{hit.path}#L{hit.start_line}-L{hit.end_line}]\n{snippet}")
        citations.append(
            Citation(
                node_type="code",
                node_id=f"{hit.repo}:{hit.path}",
                chunk_index=0,
                source="code",
                repo=hit.repo,
                path=hit.path,
                start_line=hit.start_line,
                end_line=hit.end_line,
            )
        )
    return snippets, citations


def _assemble_context(facts: LineageFacts | None, hits: list, code_snippets: list[str]) -> str:
    parts = []
    if facts is not None:
        parts.append(f"GRAPH FACTS (exact, from the project graph):\n{facts_to_text(facts)}")
    if hits:
        parts.append(
            "\n\n".join(f"[{h.node_type}:{h.node_id}#{h.chunk_index}]\n{h.content}" for h in hits)
        )
    if code_snippets:
        parts.append("\n\n".join(code_snippets))
    if not parts:
        return "(no matching project artifacts found)"
    return "\n\n".join(parts)
