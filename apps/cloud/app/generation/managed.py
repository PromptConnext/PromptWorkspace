"""Managed Typhoon model source (M2, plan 0007) — the free opentyphoon.ai
chat API as a platform-operated model connection, built once at startup from
`Settings.managed_model_*` (app/config.py) and handed to `select_model()` as
the fallback when a workspace has no BYO connection. Chat only: the pilot's
free tier isn't used for embeddings, so this connection carries no
`embed_model` — retrieval-grounded stages (specify/plan) skip retrieval
gracefully when it's the resolved connection, mirroring how the RAG embed
queue already skips (not errors) a missing BYO connection.
"""

from __future__ import annotations

from app.config import Settings
from app.models.schemas import ModelConnection
from app.secrets import SecretStore

# Not a real workspace — this connection is synthesized per request and
# never written to pw_workspace_model_connections, so there's no real id to
# use. Present only so ModelConnection's required field is satisfied.
MANAGED_WORKSPACE_MARKER = "__managed__"


def build_managed_connection(
    settings: Settings, secret_store: SecretStore
) -> ModelConnection | None:
    if not settings.managed_model_enabled or not settings.managed_model_api_key:
        return None
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url=settings.managed_model_base_url,
        model=settings.managed_model_name,
        embed_model="",
        embed_dim=0,
        secret_ref=secret_store.encrypt(settings.managed_model_api_key),
        daily_token_budget=settings.managed_daily_token_budget,
        created_by="platform",
        source="managed",
    )


def build_managed_embed_connection(
    settings: Settings, secret_store: SecretStore
) -> ModelConnection | None:
    """The separate platform embedding model (plan 0008 M1) a keyless
    workspace's assistant uses to ground content questions — Typhoon itself
    is chat-only. Returns `None` when unconfigured (empty base_url/model),
    which the assistant treats as "no embeddings available" rather than an
    error: lineage/status questions still answer on the managed chat model
    alone."""
    if not settings.managed_model_enabled:
        return None
    if not settings.managed_embed_base_url or not settings.managed_embed_model:
        return None
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="platform-embed",
        base_url=settings.managed_embed_base_url,
        model="",
        embed_model=settings.managed_embed_model,
        embed_dim=settings.managed_embed_dim,
        secret_ref=secret_store.encrypt(settings.managed_embed_api_key),
        daily_token_budget=settings.managed_daily_token_budget,
        created_by="platform",
        source="managed",
    )
