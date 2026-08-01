"""GET /workspaces/{id}/model-connection — the non-secret status the workspace
settings UI renders.

The route exists because "is a BYO connection configured?" is not the question
a user needs answered. What matters is whether the assistant can answer at all,
and that depends on the managed tier too: a workspace with no connection is
fine on a deployment with managed chat + embeddings, and completely mute on one
without. These tests pin both readings, plus the admin gate and the invariant
that no secret leaves through this route.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
API_KEY = "sk-live-secret-value"


def _managed(provider: str, *, chat: bool) -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider=provider,
        base_url="https://managed.internal/v1",
        model="typhoon-v2.5-30b-a3b-instruct" if chat else "",
        embed_model="" if chat else "bge-m3",
        embed_dim=0 if chat else 1536,
        secret_ref="unused-in-these-tests",
        daily_token_budget=20_000,
        created_by="platform",
        source="managed",
    )


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        # Default: a deployment with no managed tier at all.
        c.app.state.managed_connection = None
        c.app.state.managed_embed_connection = None
        yield c


def _workspace(client: TestClient) -> str:
    return client.post("/workspaces", json={"name": "Acme"}, headers=ALICE).json()["id"]


def _status(client: TestClient, ws_id: str, headers=ALICE):
    return client.get(f"/workspaces/{ws_id}/model-connection", headers=headers)


def _connect(client: TestClient, ws_id: str):
    return client.post(
        f"/workspaces/{ws_id}/model-connection",
        json={
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "embed_model": "text-embedding-3-small",
            "embed_dim": 1536,
            "api_key": API_KEY,
            "daily_token_budget": 200_000,
        },
        headers=ALICE,
    )


def test_no_connection_and_no_managed_tier_reports_none(client: TestClient):
    """The case the settings UI must warn on: nothing can answer a question."""
    ws_id = _workspace(client)
    body = _status(client, ws_id).json()
    assert body["configured"] is False
    assert body["connection"] is None
    assert body["chat_source"] == "none"
    assert body["embed_source"] == "none"


def test_managed_tier_covers_an_unconfigured_workspace(client: TestClient):
    ws_id = _workspace(client)
    client.app.state.managed_connection = _managed("typhoon", chat=True)
    client.app.state.managed_embed_connection = _managed("platform-embed", chat=False)

    body = _status(client, ws_id).json()
    assert body["configured"] is False
    assert body["chat_source"] == "managed"
    assert body["embed_source"] == "managed"


def test_managed_chat_without_managed_embeddings_reports_embed_none(client: TestClient):
    """Typhoon is chat-only, so a deployment can have managed chat and no
    embeddings — content questions degrade even though the assistant replies."""
    ws_id = _workspace(client)
    client.app.state.managed_connection = _managed("typhoon", chat=True)
    client.app.state.managed_embed_connection = None

    body = _status(client, ws_id).json()
    assert body["chat_source"] == "managed"
    assert body["embed_source"] == "none"


def test_configured_workspace_reports_byo_without_leaking_the_key(client: TestClient):
    ws_id = _workspace(client)
    assert _connect(client, ws_id).status_code == 200

    res = _status(client, ws_id)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is True
    assert body["chat_source"] == "byo"
    assert body["embed_source"] == "byo"
    assert body["connection"]["model"] == "gpt-4o-mini"
    assert body["connection"]["embed_model"] == "text-embedding-3-small"
    assert API_KEY not in res.text
    assert "secret_ref" not in res.text


def test_byo_wins_over_the_managed_tier(client: TestClient):
    ws_id = _workspace(client)
    client.app.state.managed_connection = _managed("typhoon", chat=True)
    client.app.state.managed_embed_connection = _managed("platform-embed", chat=False)
    assert _connect(client, ws_id).status_code == 200

    body = _status(client, ws_id).json()
    assert body["chat_source"] == "byo"
    assert body["embed_source"] == "byo"


def test_non_admin_cannot_read_the_status(client: TestClient):
    ws_id = _workspace(client)
    assert _status(client, ws_id, headers=BOB).status_code in (403, 404)
