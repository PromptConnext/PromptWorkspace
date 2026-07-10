"""Application configuration (Pydantic Settings).

Loaded from environment / .env.local. Mirrors the Ideva Kit config style so the
two backends feel familiar.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env.local", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # "memory" needs no external services and is used for tests / local dev.
    # "supabase" persists to Postgres via the Supabase client.
    data_backend: Literal["memory", "supabase"] = "memory"

    supabase_url: str = ""
    supabase_key: str = ""

    app_env: str = "development"
    log_level: str = "INFO"

    cors_origins: str = "http://localhost:3000,http://localhost:1420"

    # Tombstone GC (Milestone 1): rows with deleted_at older than this are
    # hard-deleted. Safe once every client has plausibly pulled past them.
    # Set to 0 to disable the background purge loop entirely.
    tombstone_ttl_days: int = 30
    tombstone_gc_interval_seconds: int = 3600

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def require_supabase(self) -> None:
        if self.data_backend == "supabase" and not (self.supabase_url and self.supabase_key):
            raise RuntimeError(
                "DATA_BACKEND=supabase requires SUPABASE_URL and SUPABASE_KEY to be set."
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
