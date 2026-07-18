"""In-process embed-on-ingest queue + background worker (M9, extended M11).

The sync upsert path (app/api/sync.py) only calls `enqueue()` — a non-blocking
put — never the embedding call itself. `embed_worker_loop` (started in
app/main.py's lifespan, same shape as the tombstone GC loop) drains the queue
and does the actual chunk + embed + upsert. A workspace with no model
connection configured yet is skipped (logged), not an error: RAG is opt-in,
sync must keep working without it.

`enqueue()` is called from synchronous FastAPI route handlers, which run in a
worker thread — `asyncio.Queue` is not thread-safe across threads, so the put
is marshalled onto the event-loop thread via `call_soon_threadsafe` rather
than called directly.

M11 reuses this same off-request-path queue for code files: fetching a file
from GitHub is exactly the kind of external call that must never block a
webhook response, the same reasoning that already applies to the embedding
call itself.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app.rag.chunker import chunk_text
from app.rag.code_chunker import chunk_code
from app.rag.source import node_text

logger = logging.getLogger("promptconnext.rag")


@dataclass(frozen=True)
class EmbedJob:
    workspace_id: str
    project_id: str
    node_type: str
    node_id: str
    # Only set when node_type == "code_file" (M11) — code isn't fetched via
    # get_node()/node_text() like every other node_type, since the fetched
    # content must never be persisted (ADR 0011: no source at rest), only
    # used transiently within this one job.
    repo: str | None = None
    path: str | None = None
    sha: str | None = None


class EmbedQueue:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[EmbedJob] = asyncio.Queue()

    async def get(self) -> EmbedJob:
        return await self._queue.get()

    def task_done(self) -> None:
        self._queue.task_done()

    def put_nowait(self, job: EmbedJob) -> None:
        self._queue.put_nowait(job)


def enqueue(app: Any, job: EmbedJob) -> None:
    """Safe to call from a sync request handler or the event-loop thread."""
    queue: EmbedQueue = app.state.embed_queue
    loop: asyncio.AbstractEventLoop | None = getattr(app.state, "loop", None)
    if loop is None:
        queue.put_nowait(job)  # e.g. called during startup/tests, same thread
        return
    loop.call_soon_threadsafe(queue.put_nowait, job)


async def embed_worker_loop(app: Any) -> None:
    queue: EmbedQueue = app.state.embed_queue
    while True:
        job = await queue.get()
        try:
            await _process_job(app, job)
        except Exception:  # noqa: BLE001 - one bad job must never kill the worker
            logger.exception("embed job failed node=%s type=%s", job.node_id, job.node_type)
        finally:
            queue.task_done()


async def _process_job(app: Any, job: EmbedJob) -> None:
    if job.node_type == "code_file":
        await _process_code_file_job(app, job)
        return

    repo = app.state.repository
    conn = repo.get_model_connection(job.workspace_id)
    if conn is None:
        logger.info("skip embed: no model connection workspace=%s", job.workspace_id)
        return

    node = repo.get_node(job.project_id, job.node_type, job.node_id)
    if node is None or node.deleted_at is not None:
        repo.delete_rag_chunks_for_node(job.node_id)
        return

    if job.node_type == "discussions" and getattr(node, "source", "pz") == "pmo":
        # Third-party content defaults out of the index (ADR 0011). Not an
        # error — same "skip, log, don't fail the queue" shape as a missing
        # model connection above.
        workspace = repo.get_workspace(job.workspace_id)
        if workspace is None or not workspace.rag_index_pmo_discussions:
            logger.info(
                "skip embed: pmo discussion not opted in workspace=%s node=%s",
                job.workspace_id,
                job.node_id,
            )
            repo.delete_rag_chunks_for_node(job.node_id)
            return

    text = node_text(job.node_type, node)
    chunks = chunk_text(text)
    if not chunks:
        repo.delete_rag_chunks_for_node(job.node_id)
        return

    secret_store = app.state.secret_store
    api_key = secret_store.decrypt(conn.secret_ref)
    embedder = app.state.embedding_provider
    vectors = await embedder.embed(chunks, conn.embed_model, api_key, conn.base_url)
    repo.upsert_rag_chunks(
        job.workspace_id, job.project_id, job.node_type, job.node_id, chunks, vectors
    )


async def _process_code_file_job(app: Any, job: EmbedJob) -> None:
    """Fetch, chunk, embed, store refs — the fetched content (`content`,
    `texts` below) never leaves this function; only line ranges and
    embeddings reach `upsert_code_chunks` (ADR 0011: no source at rest)."""
    repo = app.state.repository
    conn = repo.get_model_connection(job.workspace_id)
    if conn is None:
        logger.info("skip code embed: no model connection workspace=%s", job.workspace_id)
        return

    settings = app.state.settings
    if not (settings.github_app_id and settings.github_app_private_key):
        logger.warning("skip code embed: github app not configured")
        return

    workspace = repo.get_workspace(job.workspace_id)
    github_config = (workspace.integration_config or {}).get("github") if workspace else None
    if not github_config:
        logger.info("skip code embed: github not installed for workspace=%s", job.workspace_id)
        return

    github_client = app.state.github_client
    token = await github_client.mint_installation_token(
        settings.github_app_id, settings.github_app_private_key, github_config["installation_id"]
    )
    content = await github_client.fetch_file_content(token, job.repo, job.path, job.sha)
    chunks = chunk_code(content)
    if not chunks:
        repo.delete_code_chunks_for_path(job.project_id, job.repo, job.path)
        return

    texts = [c[0] for c in chunks]
    line_ranges = [(c[1], c[2]) for c in chunks]

    secret_store = app.state.secret_store
    api_key = secret_store.decrypt(conn.secret_ref)
    embedder = app.state.embedding_provider
    vectors = await embedder.embed(texts, conn.embed_model, api_key, conn.base_url)
    repo.upsert_code_chunks(
        job.workspace_id, job.project_id, job.repo, job.path, job.sha, line_ranges, vectors
    )
