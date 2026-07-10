"""FastAPI application entrypoint.

Run:  uvicorn app.main:app --reload --port 8080 --env-file=.env.local
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import health, sync, workspaces
from app.config import Settings, get_settings
from app.db.repository import InMemoryRepository, Repository
from app.ratelimit import RateLimitMiddleware, TokenBucketLimiter

logger = logging.getLogger("promptzone")


def _build_repository(settings: Settings) -> Repository:
    settings.require_supabase()
    settings.require_auth()
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
    logging.basicConfig(level=settings.log_level)
    app.state.settings = settings
    app.state.repository = _build_repository(settings)
    logger.info(
        "PromptZone Cloud %s started (backend=%s)",
        __version__,
        app.state.repository.backend_name,
    )
    gc_task = asyncio.create_task(_tombstone_gc_loop(app, settings))
    try:
        yield
    finally:
        gc_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await gc_task


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="PromptZone Cloud",
        version=__version__,
        summary="Thin sync + collaboration backend for the PromptZone task graph.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    if settings.rate_limit_enabled:
        app.add_middleware(
            RateLimitMiddleware,
            limiter=TokenBucketLimiter(
                per_minute=settings.rate_limit_per_minute,
                burst=settings.rate_limit_burst,
            ),
        )
    app.include_router(health.router)
    app.include_router(workspaces.router)
    app.include_router(sync.router)

    @app.get("/", tags=["health"])
    def root() -> dict:
        return {"service": "promptzone-cloud", "version": __version__, "docs": "/docs"}

    return app


app = create_app()
