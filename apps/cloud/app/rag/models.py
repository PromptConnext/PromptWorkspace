"""Model-source resolution for the RAG assistant (plan 0008 M1).

The RAG assistant keeps its own BYO-then-managed fallback here — unlike the
Planner's `app/generation/routing.py`, which the cloud Planner UI feature
(docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md) made
unconditionally managed-only. The assistant also needs a *pair* — a chat
connection and a (possibly different) embedding connection — since the
managed tier's Typhoon chat model has no embeddings endpoint of its own
(plan 0007 M2) and needs a separate platform embedding model
(`Settings.managed_embed_*`, `app/generation/managed.py`) instead.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.db.repository import Repository
from app.models.schemas import ModelConnection


@dataclass(frozen=True)
class AssistantModels:
    chat: ModelConnection
    # None => no embeddings available. Lineage/status questions (an exact
    # graph walk, no embeddings involved) still answer; content/mixed
    # questions degrade to "no matching artifacts" rather than erroring —
    # same "skip, don't fail" shape the embed queue uses for a missing BYO
    # connection (app/rag/queue.py).
    embed: ModelConnection | None


def resolve_assistant_models(
    repo: Repository,
    workspace_id: str,
    managed_chat_connection: ModelConnection | None,
    managed_embed_connection: ModelConnection | None,
) -> AssistantModels | None:
    byo = repo.get_model_connection(workspace_id)
    if byo is not None:
        return AssistantModels(chat=byo, embed=byo)
    if managed_chat_connection is None:
        return None
    return AssistantModels(chat=managed_chat_connection, embed=managed_embed_connection)
