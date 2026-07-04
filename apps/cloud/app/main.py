"""FastAPI application entrypoint.

Run:  uvicorn app.main:app --reload --port 8080 --env-file=.env.local
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api import health, sync
from app.config import Settings, get_settings
from app.db.repository import InMemoryRepository, Repository


def _build_repository(settings: Settings) -> Repository:
    settings.require_supabase()
    if settings.data_backend == "supabase":
        from app.db.supabase_repository import SupabaseRepository

        return SupabaseRepository(settings.supabase_url, settings.supabase_key)
    return InMemoryRepository()


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logging.basicConfig(level=settings.log_level)
    app.state.settings = settings
    app.state.repository = _build_repository(settings)
    logging.getLogger("promptzone").info(
        "PromptZone Cloud %s started (backend=%s)",
        __version__,
        app.state.repository.backend_name,
    )
    yield


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
    app.include_router(health.router)
    app.include_router(sync.router)

    @app.get("/", tags=["health"])
    def root() -> dict:
        return {"service": "promptzone-cloud", "version": __version__, "docs": "/docs"}

    return app


app = create_app()
