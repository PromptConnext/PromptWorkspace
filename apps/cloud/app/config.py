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

    # "stub"     — identity from an X-User-Id header (tests / local dev).
    # "supabase" — verify a real Supabase HS256 bearer JWT on every request.
    auth_mode: Literal["stub", "supabase"] = "stub"
    supabase_jwt_secret: str = ""

    app_env: str = "development"
    log_level: str = "INFO"

    cors_origins: str = "http://localhost:3000,http://localhost:1420"

    # External-tracker credentials (M5). Kept in the server env / secret manager,
    # never in a workspace row (ADR 0010 §5). Outbound Jira uses Basic auth
    # (email + API token); inbound webhooks are HMAC-verified with the secret.
    jira_email: str = ""
    jira_api_token: str = ""
    jira_webhook_secret: str = ""

    # Presence (M6): ephemeral who's-here over WebSocket. In-memory, single
    # instance — horizontal scale needs a Redis/pub-sub backplane (flagged).
    ws_heartbeat_seconds: int = 20
    ws_max_connections_per_project: int = 50

    # Rate limiting (M4/M7): token bucket per identity on /sync and webhook
    # endpoints. `burst` is the bucket capacity; `per_minute` the refill rate.
    rate_limit_enabled: bool = True
    rate_limit_per_minute: int = 300
    rate_limit_burst: int = 60

    # Tombstone GC (Milestone 1): rows with deleted_at older than this are
    # hard-deleted. Safe once every client has plausibly pulled past them.
    # Set to 0 to disable the background purge loop entirely.
    tombstone_ttl_days: int = 30
    tombstone_gc_interval_seconds: int = 3600

    # RAG assistant v1 (M9): symmetric key (Fernet) for workspace model-key
    # secret_ref encryption (app/secrets.py). Never written to Supabase. Empty
    # falls back to an unencrypted dev store — fine for data_backend=memory,
    # rejected at the model-connection endpoint when data_backend=supabase.
    rag_key_encryption_key: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    def require_supabase(self) -> None:
        if self.data_backend == "supabase" and not (self.supabase_url and self.supabase_key):
            raise RuntimeError(
                "DATA_BACKEND=supabase requires SUPABASE_URL and SUPABASE_KEY to be set."
            )

    def require_auth(self) -> None:
        # Modern Supabase projects sign JWTs asymmetrically and are verified
        # via SUPABASE_URL's JWKS endpoint — no shared secret needed for that
        # path. SUPABASE_JWT_SECRET is only required as the legacy HS256
        # fallback when SUPABASE_URL isn't set (see app/dependencies.py).
        if self.auth_mode == "supabase" and not (self.supabase_url or self.supabase_jwt_secret):
            raise RuntimeError(
                "AUTH_MODE=supabase requires SUPABASE_URL (for JWKS verification) or "
                "SUPABASE_JWT_SECRET (legacy HS256 secret from Supabase project "
                "settings → API → JWT Settings)."
            )

    def require_rag(self) -> None:
        # Checked lazily at the model-connection endpoint, not app startup:
        # RAG is opt-in per workspace, so an existing supabase deployment that
        # hasn't configured it yet must keep booting.
        if self.data_backend == "supabase" and not self.rag_key_encryption_key:
            raise RuntimeError(
                "RAG_KEY_ENCRYPTION_KEY is required to store a workspace model "
                "connection when DATA_BACKEND=supabase (generate one with "
                "`python -c \"from cryptography.fernet import Fernet; "
                'print(Fernet.generate_key().decode())"`).'
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()
