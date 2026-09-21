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

`EmbedQueue` also keeps a per-project in-flight count and the last failure or
silent drop per project, which is what GET .../assistant/index-status reports
as `pending_jobs` / `last_error`. Both are bookkeeping around the same
enqueue/complete pair — a measured count, not an estimate — so an operator can
tell "still draining" apart from "dropped, nothing will ever arrive" (the
no-model-connection branch below), which the chunk count alone can't express.
They live in this process's memory only: a restart resets them, and a
multi-instance deployment would see only its own share, the same
single-instance constraint presence already carries.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any

from app.integrations.github_auth import resolve_token
from app.rag.chunker import chunk_text
from app.rag.code_chunker import chunk_code
from app.rag.source import node_text
from app.requestlog import get_request_id, request_id_scope

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
    # The request that caused this job to exist (plan 0021 M3). This queue is
    # the one genuinely asynchronous path in the service, so without it the
    # request whose push or upload filled the queue and the worker line
    # reporting a failure half a second later cannot be tied together. Stamped
    # by `enqueue()`; None for a job with no request behind it.
    request_id: str | None = None


@dataclass(frozen=True)
class JobFailure:
    """Why a project's last job produced no chunks. `code` is a stable
    machine string the UI can branch on; `message` is the human detail."""

    code: str
    message: str
    node_type: str
    node_id: str
    at: datetime


class EmbedQueue:
    """Counting is deliberately separate from delivery (`reserve` vs
    `deliver`). The asyncio put has to happen on the event-loop thread, so
    `enqueue()` marshals it — but a count that also waited for that callback
    would still read zero at the moment `POST .../reindex` returns, which is
    exactly when the client asks. The panel would then see "nothing pending",
    never start polling, and sit on pre-sweep numbers until a manual reload:
    the reserved-then-delivered split is what makes the depth true as soon as
    the enqueueing request can be observed at all.

    A lock rather than bare dict ops: reservations come from request threads
    while completions come from the loop thread, and read-modify-write on a
    counter is not atomic — free-threaded builds aside, `+= 1` is three
    bytecodes even under a GIL.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[EmbedJob] = asyncio.Queue()
        self._lock = threading.Lock()
        self._pending: dict[str, int] = {}
        self._failures: dict[str, JobFailure] = {}

    async def get(self) -> EmbedJob:
        return await self._queue.get()

    def reserve(self, job: EmbedJob) -> None:
        """Count a job as in-flight. Thread-safe, and correct to call before
        the job physically reaches the asyncio queue."""
        with self._lock:
            self._pending[job.project_id] = self._pending.get(job.project_id, 0) + 1

    def deliver(self, job: EmbedJob) -> None:
        """Event-loop thread only: hand an already-reserved job to the queue."""
        self._queue.put_nowait(job)

    def complete(self, job: EmbedJob) -> None:
        """Mark one job finished — settled or failed, both leave the queue."""
        with self._lock:
            remaining = self._pending.get(job.project_id, 1) - 1
            if remaining > 0:
                self._pending[job.project_id] = remaining
            else:
                self._pending.pop(job.project_id, None)
        self._queue.task_done()

    def put_nowait(self, job: EmbedJob) -> None:
        """reserve + deliver for callers already on the event-loop thread."""
        self.reserve(job)
        self.deliver(job)

    def pending_for(self, project_id: str) -> int:
        with self._lock:
            return self._pending.get(project_id, 0)

    def record_failure(
        self, job: EmbedJob, code: str, message: str, *, at: datetime | None = None
    ) -> None:
        with self._lock:
            self._failures[job.project_id] = JobFailure(
                code=code,
                message=message,
                node_type=job.node_type,
                node_id=job.node_id,
                at=at or datetime.now(timezone.utc),
            )

    def clear_failure(self, project_id: str) -> None:
        """A job that actually stored chunks retires the project's last
        error — otherwise a fixed misconfiguration keeps accusing itself
        long after the reindex that fixed it succeeded."""
        with self._lock:
            self._failures.pop(project_id, None)

    def last_failure_for(self, project_id: str) -> JobFailure | None:
        with self._lock:
            return self._failures.get(project_id)


def enqueue(app: Any, job: EmbedJob) -> None:
    """Safe to call from a sync request handler or the event-loop thread.

    The reservation is taken here, synchronously, so the job is already
    counted by the time the enqueueing request returns; only the asyncio put
    is deferred to the loop thread.

    The request id is stamped here rather than at each call site. This function
    is the single funnel every producer goes through — the sync upsert, a new
    discussion, a document upload, the GitHub webhook's push handler, stage
    apply and the model-connection backfill — so one line covers all of them
    and, more to the point, cannot be the line a future caller forgets. A job
    that arrives already carrying an id keeps it, which is what the field being
    a parameter rather than an internal is for.
    """
    if job.request_id is None:
        job = replace(job, request_id=get_request_id())
    queue: EmbedQueue = app.state.embed_queue
    queue.reserve(job)
    loop: asyncio.AbstractEventLoop | None = getattr(app.state, "loop", None)
    if loop is None:
        queue.deliver(job)  # e.g. called during startup/tests, same thread
        return
    loop.call_soon_threadsafe(queue.deliver, job)


async def embed_worker_loop(app: Any) -> None:
    queue: EmbedQueue = app.state.embed_queue
    while True:
        job = await queue.get()
        # Rebinding the enqueueing request's id for the duration of this job is
        # what makes every line below — including the `logger.exception` in the
        # except arm, which nothing here had to be taught about request ids —
        # come out attributed to the request that caused the work. A background
        # worker has no ASGI scope to hang a contextvar off, so the job carries
        # the id and this restores it; the scope resets between jobs, or one
        # failure would go out labelled with the previous request.
        with request_id_scope(job.request_id):
            try:
                await _process_job(app, job)
            except Exception as exc:  # noqa: BLE001 - one bad job must never kill the worker
                logger.exception("embed job failed node=%s type=%s", job.node_id, job.node_type)
                # Same reason index-status exists: the operator otherwise sees a
                # chunk count that never moves and no way to learn why.
                queue.record_failure(job, "embed_failed", str(exc) or type(exc).__name__)
            finally:
                queue.complete(job)


async def _process_job(app: Any, job: EmbedJob) -> None:
    if job.node_type == "code_file":
        await _process_code_file_job(app, job)
        return

    queue: EmbedQueue = app.state.embed_queue
    repo = app.state.repository
    conn = repo.get_model_connection(job.workspace_id)
    if conn is None:
        # Plan 0008 M1: a keyless (no BYO) workspace still embeds via the
        # platform embedding model, same fallback resolve_assistant_models()
        # uses at query time — otherwise an upload never gets indexed at all
        # for a business workspace on the managed tier.
        conn = getattr(app.state, "managed_embed_connection", None)
    if conn is None:
        # Steady-state condition, not an event: it repeats once per node on
        # every push for a workspace that has no connection configured. Logged
        # at debug for that reason — but recorded as this project's last error
        # regardless, because from the operator's side it is indistinguishable
        # from a stuck queue: jobs enqueued, chunk count frozen at zero. This
        # drop is exactly what a "0 chunks indexed · 59 items queued" screen
        # cannot otherwise explain.
        logger.debug("skip embed: no model connection workspace=%s", job.workspace_id)
        queue.record_failure(
            job,
            "no_model_connection",
            "No embedding model resolved for this workspace — jobs were discarded, "
            "not deferred. Configure a workspace model connection (or enable the "
            "managed tier) and reindex.",
        )
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
    vectors = await embedder.embed(
        chunks, conn.embed_model, api_key, conn.base_url, conn.embed_dim
    )
    repo.upsert_rag_chunks(
        job.workspace_id,
        job.project_id,
        job.node_type,
        job.node_id,
        chunks,
        vectors,
        embed_model=conn.embed_model,
        embed_dim=conn.embed_dim,
    )
    queue.clear_failure(job.project_id)


async def _process_code_file_job(app: Any, job: EmbedJob) -> None:
    """Fetch, chunk, embed, store refs — the fetched content (`content`,
    `texts` below) never leaves this function; only line ranges and
    embeddings reach `upsert_code_chunks` (ADR 0011: no source at rest)."""
    queue: EmbedQueue = app.state.embed_queue
    repo = app.state.repository
    conn = repo.get_model_connection(job.workspace_id)
    if conn is None:
        logger.info("skip code embed: no model connection workspace=%s", job.workspace_id)
        queue.record_failure(
            job,
            "no_model_connection",
            "No embedding model configured for this workspace — code files were "
            "discarded, not deferred.",
        )
        return

    workspace = repo.get_workspace(job.workspace_id)
    resolved = resolve_token(app, workspace)
    if resolved is None:
        logger.info("skip code embed: github not connected for workspace=%s", job.workspace_id)
        queue.record_failure(
            job,
            "github_not_connected",
            "No usable GitHub token for this workspace — code files can't be fetched "
            "to index.",
        )
        return
    token, _ = resolved

    github_client = app.state.github_client
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
    vectors = await embedder.embed(
        texts, conn.embed_model, api_key, conn.base_url, conn.embed_dim
    )
    repo.upsert_code_chunks(
        job.workspace_id, job.project_id, job.repo, job.path, job.sha, line_ranges, vectors
    )
    queue.clear_failure(job.project_id)
