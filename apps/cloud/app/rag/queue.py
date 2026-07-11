"""In-process embed-on-ingest queue + background worker (M9).

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
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

from app.rag.chunker import chunk_text
from app.rag.source import node_text

logger = logging.getLogger("promptzone.rag")


@dataclass(frozen=True)
class EmbedJob:
    workspace_id: str
    project_id: str
    node_type: str
    node_id: str


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
    repo = app.state.repository
    conn = repo.get_model_connection(job.workspace_id)
    if conn is None:
        logger.info("skip embed: no model connection workspace=%s", job.workspace_id)
        return

    node = repo.get_node(job.project_id, job.node_type, job.node_id)
    if node is None or node.deleted_at is not None:
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
