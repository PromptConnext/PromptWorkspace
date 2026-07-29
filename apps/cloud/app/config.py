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

    # Personal-workspace auto-provision (ADR 0015 §5, plan 0006 G1). When an
    # authenticated user resolves to ZERO workspace memberships on GET
    # /workspaces, mint a default "{user}'s workspace" with that user as admin.
    # Removes the zero-workspace dead-end the desktop membership gate would
    # otherwise create on every fresh account. Idempotent (a no-op once any
    # membership exists). Set to false to stage the rollout / disable.
    auto_provision_personal_workspace: bool = True

    cors_origins: str = "http://localhost:3000,http://localhost:1420"

    # Where invitation accept links point (the web app). Used to build the
    # accept URL emailed to invitees; also the Supabase invite redirect target.
    web_app_url: str = "http://localhost:3000"

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

    # Git-host integration (M11): one GitHub App shared across all workspaces
    # — same shape as the Jira/ClickUp env-level credentials above. Never
    # stored in Supabase; per-workspace config (installation_id, repo,
    # default_branch) is non-secret and lives on the workspace row instead.
    # No installation access token is ever persisted — app/integrations/
    # github.py mints one on demand from the private key and discards it.
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_webhook_secret: str = ""

    # Managed Thai-LLM tier (M2, plan 0007 / ADR 0013 Part B pilot): the free
    # opentyphoon.ai API as a platform-operated model source for workspaces
    # with no BYO connection. Chat only in the pilot — no managed embedding
    # model, so retrieval-grounded stages skip retrieval gracefully when this
    # is the resolved connection (same "skip, don't error" shape the RAG
    # embed queue already uses for a missing BYO connection, app/rag/queue.py).
    # The API key is platform-held (env/secret store), never a per-user or
    # per-workspace value.
    managed_model_enabled: bool = False
    managed_model_base_url: str = "https://api.opentyphoon.ai/v1"
    managed_model_name: str = "typhoon-v2.5-30b-a3b-instruct"
    managed_model_api_key: str = ""
    # Explicit completion cap. Left unset, an OpenAI-compatible provider
    # applies its own default — for opentyphoon.ai that default is small
    # enough to cut a Spec Kit document off mid-section, which is exactly
    # what the Planner's specify stage produces. A stage document is a whole
    # filled-in template, so budget for one: the engine's own gateway
    # (apps/engine/src/gateway/index.ts) has always sent max_tokens, and this
    # is the cloud Planner reaching parity.
    managed_model_max_tokens: int = 8_000
    # Conservative shared-key protection (ADR 0013 flags the free tier as
    # 5 req/s / 200 req/min, shared across every workspace using it): a
    # per-workspace daily cap so one workspace can't exhaust the platform's
    # shared budget, on top of the existing per-workspace DailyTokenBudget
    # check every generation stage already goes through. Sized against a real
    # stage run rather than a round number: specify injects up to
    # _DOCUMENT_CONTEXT_BUDGET (40k chars ≈ 10k tokens) of PRD plus an 8k
    # completion, so the old 20k ceiling allowed roughly one generation per
    # workspace per day and then 429'd the rest of the 3S flow.
    managed_daily_token_budget: int = 200_000

    # Managed embeddings for the assistant (plan 0008 M1): Typhoon is
    # generation-only, so a keyless (no BYO) workspace needs a separate
    # platform-hosted embedding model to ground content questions. Any
    # OpenAI-compatible /embeddings endpoint works (Text-Embeddings-Inference,
    # vLLM, ...) — recommend a BGE-m3-class multilingual model for Thai+
    # English. IMPORTANT: pz_rag_chunks.embedding is a fixed vector(1536)
    # column (migrations/0009_rag.sql) — the chosen model's output dimension
    # must be 1536, or chunks embedded with it won't fit the column at all.
    # Left unset (empty base_url/model), the assistant still answers
    # lineage/status questions on the managed chat model alone; content
    # questions degrade to "no matching artifacts" rather than erroring.
    managed_embed_base_url: str = ""
    managed_embed_model: str = ""
    managed_embed_dim: int = 1536
    managed_embed_api_key: str = ""

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

    def require_production_safety(self) -> list[str]:
        """Hard-refuse boot-time misconfigurations that are safe in dev but
        dangerous in production.

        Stub auth (X-User-Id header, no verification) is a full auth bypass —
        raise and refuse to start. A CORS allowlist still pointed at the
        localhost dev defaults is not itself an auth bypass, so it only
        warns (returned, not logged here — the caller owns logging).
        """
        if self.app_env == "production" and self.auth_mode == "stub":
            raise RuntimeError(
                "APP_ENV=production requires AUTH_MODE=supabase. AUTH_MODE=stub "
                "trusts an unverified X-User-Id header and lets any caller act "
                "as any user — this is a full authentication bypass and must "
                "never run in production."
            )

        warnings: list[str] = []
        default_cors = {
            o.strip()
            for o in "http://localhost:3000,http://localhost:1420".split(",")
            if o.strip()
        }
        if self.app_env == "production" and set(self.cors_origin_list) <= default_cors:
            warnings.append(
                "APP_ENV=production but CORS_ORIGINS is still the localhost dev "
                "default ({}); set CORS_ORIGINS to your production origin(s).".format(
                    ", ".join(sorted(default_cors))
                )
            )
        return warnings


@lru_cache
def get_settings() -> Settings:
    return Settings()
