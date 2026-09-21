"""FastAPI application entrypoint.

Run:  uvicorn app.main:app --reload --port 8080 --env-file=.env.local
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import (
    assistant,
    deployments,
    desktop_auth,
    discussions,
    documents,
    generation,
    github,
    health,
    integrations,
    me,
    policies,
    presence,
    stage_documents,
    sync,
    workspaces,
)
from app.config import Settings, get_settings
from app.db.repository import InMemoryRepository, Repository
from app.documents.storage import build_document_store
from app.generation.managed import build_managed_connection, build_managed_embed_connection
from app.generation.service import HttpGenerationProvider
from app.integrations.github import HttpGithubClient
from app.observability import init_sentry
from app.rag.budget import DailyTokenBudget
from app.rag.chat import HttpChatProvider
from app.rag.embedder import HttpEmbeddingProvider
from app.rag.queue import EmbedQueue, embed_worker_loop
from app.ratelimit import RateLimitMiddleware, TokenBucketLimiter
from app.requestlog import REQUEST_ID_HEADER, RequestIdMiddleware, configure_logging
from app.secrets import build_secret_store
from app.ws.manager import ConnectionManager

logger = logging.getLogger("promptconnext")

_MIGRATIONS_DIR = Path(__file__).resolve().parents[1] / "migrations"


def _schema_version() -> str:
    """Latest bundled migration stem (e.g. '0005_tracker_links'), for /health.

    Reports what the *code* expects; a mismatch with the DB is an operator
    signal to apply pending migrations."""
    try:
        files = sorted(p.stem for p in _MIGRATIONS_DIR.glob("*.sql"))
        return files[-1] if files else "none"
    except OSError:
        return "unknown"


def _build_repository(settings: Settings) -> Repository:
    settings.require_supabase()
    settings.require_auth()
    for warning in settings.require_production_safety():
        logger.warning(warning)
    if settings.data_backend == "supabase":
        from app.db.supabase_repository import SupabaseRepository

        return SupabaseRepository(settings.supabase_url, settings.supabase_key)
    return InMemoryRepository()


async def _tombstone_gc_loop(app: FastAPI, settings: Settings) -> None:
    """Periodically hard-delete tombstones older than TOMBSTONE_TTL_DAYS.

    Deferred-then-promoted from plan 0001 M7 to M1 on request: GC ships
    alongside the tombstones it cleans up rather than later. Disabled when
    tombstone_ttl_days <= 0.
    """
    if settings.tombstone_ttl_days <= 0:
        return
    while True:
        await asyncio.sleep(settings.tombstone_gc_interval_seconds)
        try:
            purged = app.state.repository.purge_expired_tombstones(settings.tombstone_ttl_days)
            if purged:
                logger.info("Tombstone GC purged %s", purged)
        except Exception:  # noqa: BLE001 - GC must never crash the app
            logger.exception("Tombstone GC pass failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    # JSON lines carrying the request id bound by RequestIdMiddleware (plan
    # 0021 M3) — one stdlib Formatter, no new dependency. Also pins the noisy
    # httpx/h2 loggers; see app/requestlog.py::configure_logging.
    configure_logging(settings.log_level)
    # Error reporting (plan 0021 M2). Set up here alongside logging and before
    # anything else in this function can fail, so a crash during the rest of
    # startup is itself reported. A no-op with no SENTRY_DSN configured —
    # app/observability.py never calls sentry_sdk.init() in that case, and
    # require_production_safety() (via _build_repository below) warns if that
    # is what a production instance is doing.
    if init_sentry(settings, release=__version__):
        logger.info("Error reporting enabled (environment=%s)", settings.app_env)
    app.state.settings = settings
    app.state.repository = _build_repository(settings)
    app.state.presence = ConnectionManager(settings.ws_max_connections_per_project)
    from app.desktop_auth_store import HandoffStore

    app.state.handoff_store = HandoffStore()
    app.state.schema_version = _schema_version()
    # Lightweight in-process counters surfaced on /health (M7 observability).
    app.state.metrics = {"pushed": 0, "pulled": 0, "merged": 0, "conflicts": 0}
    # RAG assistant v1 (M9): in-process embed queue + worker, BYO model
    # providers, secret store, and per-workspace daily token budget. All
    # in-process/single-instance, same as presence and the rate limiter.
    app.state.loop = asyncio.get_running_loop()
    app.state.embed_queue = EmbedQueue()
    app.state.secret_store = build_secret_store(settings.rag_key_encryption_key)
    app.state.embedding_provider = HttpEmbeddingProvider()
    app.state.chat_provider = HttpChatProvider()
    app.state.token_budget = DailyTokenBudget()
    # Documents knowledge base (M0): raw-file storage seam, same shape as the
    # secret store above (memory in tests/local dev, Supabase Storage in prod).
    app.state.document_store = build_document_store(
        settings.data_backend, settings.supabase_url, settings.supabase_key
    )
    # Generation (M1): stage-prompt generation, same OpenAI-compatible
    # transport as the RAG chat provider (app/rag/chat.py::stream_openai_chat).
    app.state.generation_provider = HttpGenerationProvider()
    # Managed Typhoon tier (M2): built once here so its platform key is
    # encrypted a single time, not per request; None when unconfigured,
    # which select_model() treats identically to "no managed fallback".
    app.state.managed_connection = build_managed_connection(settings, app.state.secret_store)
    # Managed embeddings for the assistant (plan 0008 M1): a separate
    # platform embedding model, since Typhoon itself is chat-only. None when
    # unconfigured — resolve_assistant_models() treats that as "no
    # embeddings available," not an error.
    app.state.managed_embed_connection = build_managed_embed_connection(
        settings, app.state.secret_store
    )
    # managed_model_enabled=true with no resolved embed connection is an
    # operational fault, not a deliberate opt-out: every keyless workspace's
    # content questions will silently retrieve nothing and the assistant will
    # answer "I don't have enough information" as if it were a genuine
    # unknown, indistinguishable from a working deployment. A deployment
    # with the managed tier off entirely has opted out on purpose and must
    # stay quiet.
    if settings.managed_model_enabled and app.state.managed_embed_connection is None:
        logger.warning(
            "Managed embeddings are not configured (MANAGED_EMBED_BASE_URL / "
            "MANAGED_EMBED_MODEL are unset) even though MANAGED_MODEL_ENABLED=true. "
            "Keyless workspaces' assistant will still answer status/lineage "
            "questions, but every document-content question will silently "
            "return \"I don't have enough information\" with no retrieval "
            "attempted. Set MANAGED_EMBED_BASE_URL, MANAGED_EMBED_MODEL, and "
            "MANAGED_EMBED_API_KEY (see apps/cloud/.env.example) to enable "
            "content grounding."
        )
    # Global (not per-workspace) token bucket protecting the shared free
    # Typhoon key from the platform's own aggregate traffic — separate from
    # the per-workspace DailyTokenBudget check every stage already goes
    # through. Same in-process, single-instance shape as the sync/webhook
    # limiter above.
    app.state.managed_limiter = TokenBucketLimiter(per_minute=200, burst=5)
    # Git-host integration (M11): one client instance, same wiring pattern —
    # tests override app.state.github_client with FakeGithubClient.
    app.state.github_client = HttpGithubClient()
    # Per-(workspace, user) budget on the repo-listing route (import picker).
    # It reads with the workspace's own shared PAT, so a chatty client here
    # burns the same budget that repo creation, code indexing and the
    # assistant's snippet fetch all depend on — worth protecting on its own,
    # not folded into _LIMITED_PREFIXES (that list is for hot sync/webhook
    # paths; this is a one-off admin-adjacent read).
    app.state.github_read_limiter = TokenBucketLimiter(per_minute=30, burst=10)
    # Deployment templates (ADR 0021). The only place the platform's
    # account-wide R2 token is used, and the only thing that mints the
    # per-workspace credential a project repo is given. Same override seam as
    # github_client above: tests substitute FakeR2Client.
    from app.integrations.deploy_providers import CloudflareR2Client, FakeR2Client

    if settings.deploy_r2_api_token:
        app.state.r2_client = CloudflareR2Client()
    elif settings.data_backend == "memory":
        # Dev and tests only — the memory backend is already documented as
        # non-production. A configured-looking platform template must not
        # silently mint fake credentials against a real database.
        app.state.r2_client = FakeR2Client()
    else:
        # Unconfigured in production: selecting the platform-hosted template
        # then fails at repo creation with a clear code, rather than seeding a
        # pipeline that could never succeed.
        app.state.r2_client = None
    from app.invitations_email import build_invitation_mailer

    app.state.invitation_mailer = build_invitation_mailer(settings)
    logger.info(
        "PromptConnext Cloud %s started (backend=%s)",
        __version__,
        app.state.repository.backend_name,
    )
    from app.deployments.reconcile import reconcile_loop

    gc_task = asyncio.create_task(_tombstone_gc_loop(app, settings))
    embed_task = asyncio.create_task(embed_worker_loop(app))
    reconcile_task = asyncio.create_task(reconcile_loop(app, settings))
    try:
        yield
    finally:
        gc_task.cancel()
        embed_task.cancel()
        reconcile_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await gc_task
        with contextlib.suppress(asyncio.CancelledError):
            await embed_task
        with contextlib.suppress(asyncio.CancelledError):
            await reconcile_task


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="PromptConnext Cloud",
        version=__version__,
        summary="Thin sync + collaboration backend for the PromptConnext task graph.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        # A response header is invisible to browser JS unless it is exposed,
        # and the id is only half useful if the caller that sent it cannot read
        # back the one actually used (a proxy's, or a minted one when the
        # client sent none). Grep-side correlation works either way.
        expose_headers=[REQUEST_ID_HEADER],
    )
    if settings.rate_limit_enabled:
        app.add_middleware(
            RateLimitMiddleware,
            limiter=TokenBucketLimiter(
                per_minute=settings.rate_limit_per_minute,
                burst=settings.rate_limit_burst,
            ),
        )
    # Added last, so it is the outermost middleware: Starlette prepends, and
    # the first entry wraps the rest. Everything below it — the rate limiter's
    # own 429 included — is served with an id bound, and the binding happens
    # before BaseHTTPMiddleware forks the child task that would otherwise only
    # inherit a context copied too early. See app/requestlog.py.
    app.add_middleware(RequestIdMiddleware)
    app.include_router(health.router)
    app.include_router(workspaces.router)
    # github.router's static /api/webhooks/github must be registered before
    # integrations.router's /api/webhooks/{provider} — Starlette matches
    # routes in registration order, and the dynamic path param would
    # otherwise swallow the static one first (get_adapter("github") is None
    # -> a wrong 404, never reaching this router's own signature check).
    app.include_router(github.router)
    app.include_router(integrations.router)
    app.include_router(presence.router)
    app.include_router(sync.router)
    app.include_router(me.router)
    app.include_router(assistant.router)
    app.include_router(discussions.router)
    app.include_router(documents.router)
    app.include_router(generation.router)
    app.include_router(stage_documents.router)
    app.include_router(policies.router)
    app.include_router(deployments.router)
    app.include_router(desktop_auth.router)

    @app.get("/", tags=["health"])
    def root() -> dict:
        return {"service": "promptconnext-cloud", "version": __version__, "docs": "/docs"}

    return app


app = create_app()
