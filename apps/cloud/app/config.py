"""Application configuration (Pydantic Settings).

Loaded from environment / .env.local. Mirrors the Ideva Kit config style so the
two backends feel familiar.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Pinning DATA_BACKEND/AUTH_MODE in the process environment (tests/conftest.py)
# only neutralises the two settings it names — every other value in a
# developer's .env.local still bleeds into the test run and silently changes
# behaviour (a set MANAGED_MODEL_ENABLED, for one, turns "no model connection"
# from a 400 into a managed-fallback 200). Dropping the env files wholesale
# under this flag makes the suite hermetic for all settings at once rather
# than one variable at a time.
_ENV_FILES: tuple[str, ...] = (
    () if os.getenv("PROMPTWORKSPACE_DISABLE_ENV_FILE") == "1" else (".env.local", ".env")
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILES,
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

    # Error reporting (plan 0021 M2, app/observability.py). Unset means the
    # Sentry SDK is never initialised — no network, no patched frameworks,
    # nothing captured — which is the correct default for dev and for the test
    # suite. A production instance without one is running blind, so
    # require_production_safety() warns (never raises) about it below.
    sentry_dsn: str | None = None

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
    # (email + API token).
    #
    # There is deliberately no `jira_webhook_secret` any more (plan 0019): one
    # process-wide inbound secret could only prove that *some* configured Jira
    # sent a delivery, and since an issue key is unique per site rather than per
    # provider, two tenants reusing a project prefix could cross-update each
    # other's tasks. Inbound secrets are now minted per tracker account and held
    # as ciphertext in pw_workspace_integrations.
    jira_email: str = ""
    jira_api_token: str = ""

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

    # Git-host integration (M11). There is deliberately NO platform-level
    # GitHub credential here: each workspace supplies its own fine-grained
    # PAT, encrypted to a secret_ref by app/secrets.py and held on the
    # workspace row (ADR 0017 amendment). The only server-level value the
    # integration needs is where GitHub should send webhooks back to — this
    # service's own public origin. Empty disables webhook registration:
    # repo creation and seeding still work, PR/push indexing just never
    # starts, which is the correct behavior for a local dev run GitHub
    # cannot reach anyway.
    public_api_url: str = ""

    # Deployment templates (ADR 0021). Every provider except this one is a
    # per-workspace credential on the workspace row; the `static-r2` template
    # is the exception, because for it the platform *is* the provider and
    # there is no customer account to connect.
    #
    # `deploy_r2_api_token` is account-wide and MUST NOT be sealed into a
    # customer repository. It is used only to mint a per-workspace,
    # bucket-scoped credential at repo-creation time, and only that minted
    # credential reaches a repo — so a leak from any one repository is bounded
    # to that workspace's preview bucket rather than every tenant's.
    #
    # Unset disables the platform-hosted template: selecting it still works,
    # and repo creation refuses with `deployment_provider_not_configured`
    # rather than seeding a pipeline that could never succeed.
    deploy_r2_account_id: str = ""
    deploy_r2_api_token: str = ""
    deploy_r2_endpoint: str = ""
    deploy_r2_public_base_url: str = ""
    # Local-dev escape hatch: seal the platform's own key straight into the
    # repo instead of minting. Never enable this anywhere real — one leak
    # would reach every workspace's preview storage.
    deploy_r2_allow_shared_key: bool = False
    deploy_r2_shared_access_key_id: str = ""
    deploy_r2_shared_secret_access_key: str = ""
    deploy_r2_shared_bucket: str = ""

    # ADR 0023 decision 7. The sweep is an outbound poll that closes out
    # deployments a lost webhook delivery left in flight. `stale_after` is
    # generous on purpose: a mobile build legitimately takes twenty minutes,
    # and closing one out early would be worse than closing it out late.
    deployment_reconcile_interval_seconds: int = 300
    deployment_stale_after_seconds: int = 1800

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

    # TypeSafe System One (app/integrations/typesafe.py): typed judgments over
    # free text where a keyword scan used to stand in — today, which runtime
    # and services a project's plan calls for (app/deployments/stack_judge.py).
    # Optional: unset means no client is built and every caller keeps its
    # deterministic keyword path, which is also what the test suite runs.
    typesafe_api_key: str = ""
    typesafe_base_url: str = "https://api.typesafe.ai/v1"
    typesafe_model: str = "jev-latest"

    # Managed embeddings for the assistant (plan 0008 M1): Typhoon is
    # generation-only, so a keyless (no BYO) workspace needs a separate
    # platform-hosted embedding model to ground content questions. Any
    # OpenAI-compatible /embeddings endpoint works (Text-Embeddings-Inference,
    # vLLM, ...), but pw_rag_chunks.embedding is a fixed vector(1536) column
    # (migrations/0002_pw_baseline.sql, section 0009_rag.sql), so the chosen
    # model's output dimension must be 1536 or chunks embedded with it won't
    # fit the column at all. Most open multilingual encoders do NOT fit
    # (BGE-m3 emits 1024, Jina v3 1024, KaLM-embedding-multilingual v2.5 896);
    # known-good 1536 options are OpenAI text-embedding-3-small (1536 native),
    # Google gemini-embedding-001 via its OpenAI-compatible endpoint (3072
    # native, MRL-truncated to 1536 via the `dimensions` param), or
    # Alibaba-NLP/gte-Qwen2-1.5B-instruct (1536 native, self-hosted). Left
    # unset (empty base_url/model), the assistant still answers lineage/status
    # questions on the managed chat model alone; content questions degrade to
    # "no matching artifacts" rather than erroring.
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
        # A hosted backend without the key would silently fall back to
        # MemorySecretStore (base64, not encryption) for every workspace PAT,
        # model key and webhook secret — and a key added later cannot read
        # what was stored before it. Refuse to boot instead.
        if self.data_backend == "supabase" and not self.rag_key_encryption_key:
            raise RuntimeError(
                "DATA_BACKEND=supabase requires RAG_KEY_ENCRYPTION_KEY to be set (generate "
                "one with `python -c \"from cryptography.fernet import Fernet; "
                'print(Fernet.generate_key().decode())"`). Without it stored credentials '
                "would not be encrypted."
            )

    def require_valid_encryption_key(self) -> None:
        # A malformed key would otherwise surface only on the first secret
        # write or read, long after boot. Fernet() is the parser that the
        # secret store itself uses (app/secrets.py), so this is the same check.
        if not self.rag_key_encryption_key:
            return
        from cryptography.fernet import Fernet  # lazy, as in app/secrets.py

        try:
            Fernet(self.rag_key_encryption_key.encode())
        except (ValueError, TypeError) as exc:
            raise RuntimeError(
                "RAG_KEY_ENCRYPTION_KEY is not a valid Fernet key (it must be 32 "
                "url-safe base64-encoded bytes; generate one with `python -c \"from "
                "cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"`)."
            ) from exc

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() == "production"

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
        # Also checked at the model-connection endpoint. require_supabase()
        # already refuses to boot a supabase backend without the key, so this
        # is the per-request backstop for a Settings built outside startup.
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
        warns (returned, not logged here — the caller owns logging). So does a
        missing error-reporting DSN: running a hosted instance with no error
        visibility is an operational fault, not a security hole, and refusing
        to boot over it would take a working service down to fix a monitoring
        gap.

        APP_ENV is compared case- and whitespace-insensitively, so
        `APP_ENV=Production` cannot slip past these checks.
        """
        if self.is_production and self.auth_mode == "stub":
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
        if self.is_production and set(self.cors_origin_list) <= default_cors:
            warnings.append(
                "APP_ENV=production but CORS_ORIGINS is still the localhost dev "
                "default ({}); set CORS_ORIGINS to your production origin(s).".format(
                    ", ".join(sorted(default_cors))
                )
            )
        if self.is_production and not self.sentry_dsn:
            warnings.append(
                "Sentry DSN is not configured; a production instance is running "
                "with no error visibility. Set SENTRY_DSN to the project's ingest "
                "URL (app/observability.py scrubs every report before it leaves)."
            )
        return warnings


@lru_cache
def get_settings() -> Settings:
    return Settings()
