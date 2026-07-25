"""Keyless assistant on the managed tier (plan 0008 M1) — exit criteria:

A brand-new business workspace (no BYO connection) asks a status question
and a content question and gets correct, cited answers entirely on the
managed tier (managed chat + a separate platform embedding model, since
Typhoon itself is chat-only). Also under test: a dimension/model-mismatch
query is rejected with a clear reindex error, and the daily budget is
enforced against the managed source.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}


def _managed_chat_connection(daily_token_budget: int = 20_000) -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url="https://api.opentyphoon.ai/v1",
        model="typhoon-v2.5-30b-a3b-instruct",
        embed_model="",
        embed_dim=0,
        secret_ref="unused-in-these-tests",
        daily_token_budget=daily_token_budget,
        created_by="platform",
        source="managed",
    )


def _managed_embed_connection(embed_model: str = "bge-m3") -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="platform-embed",
        base_url="https://embed.internal/v1",
        model="",
        embed_model=embed_model,
        embed_dim=1536,
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
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.managed_connection = _managed_chat_connection()
        c.app.state.managed_embed_connection = _managed_embed_connection()
        # Real MemorySecretStore.decrypt() would choke on the placeholder
        # secret_ref above — these tests only care that the resolved
        # connections are used, not real ciphertext round-tripping.
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _bootstrap_keyless_workspace(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "Keyless W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_status_question_answers_on_managed_chat_with_no_embeddings(client: TestClient):
    ws_id, pid = _bootstrap_keyless_workspace(client)
    # No BYO connection exists for this workspace — proves the chat model
    # used really is the managed fallback.
    assert client.app.state.repository.get_model_connection(ws_id) is None

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What's the status of this project?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert "event: facts" in res.text
    assert "event: error" not in res.text


def test_content_question_grounds_via_managed_embeddings(client: TestClient):
    ws_id, pid = _bootstrap_keyless_workspace(client)

    upload = client.post(
        f"/projects/{pid}/documents",
        files={
            "file": (
                "prd.md",
                b"# Payments PRD\n\nThe rollout is codenamed ZEBRA-PAY internally.",
                "text/markdown",
            )
        },
        headers=ALICE,
    )
    assert upload.status_code == 201, upload.text
    assert _wait_until(
        lambda: len(
            client.app.state.repository.vector_search(
                ws_id, pid, [0.0] * FakeEmbeddingProvider.dim, top_k=100
            )
        )
        > 0
    )

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain the payments PRD"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert "ZEBRA-PAY" in res.text
    assert "event: error" not in res.text


def test_embed_model_mismatch_requires_reindex(client: TestClient):
    ws_id, pid = _bootstrap_keyless_workspace(client)
    # Seed a chunk as if it were embedded under a different (e.g. BYO) model
    # than the currently-resolved managed embedding connection.
    client.app.state.repository.upsert_rag_chunks(
        ws_id, pid, "documents", "doc-1", ["some prior content"], [[0.0] * 8], "old-embed-model"
    )

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain the payments PRD"},
        headers=ALICE,
    )
    assert res.status_code == 409
    assert "embed_model_mismatch" in res.json()["detail"]
    assert "reindex" in res.json()["detail"]


def test_managed_daily_budget_enforced_with_no_facts_fallback(client: TestClient):
    """A pure-content question (no lineage markers, so no graph-walk facts to
    fall back on) still hard-429s when the budget is exhausted — there's
    genuinely nothing to serve."""
    _ws_id, pid = _bootstrap_keyless_workspace(client)
    client.app.state.managed_connection = _managed_chat_connection(daily_token_budget=0)

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain the payments architecture"},
        headers=ALICE,
    )
    assert res.status_code == 429


def test_budget_exhausted_lineage_question_soft_degrades_to_facts_only(client: TestClient):
    """A status/lineage question is answered from the zero-cost graph walk
    even with the budget exhausted — no hard 429, no LLM stream call."""
    _ws_id, pid = _bootstrap_keyless_workspace(client)
    client.app.state.managed_connection = _managed_chat_connection(daily_token_budget=0)

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What's the status of this project?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert "event: facts" in res.text
    assert "budget reached" in res.text.lower()
    # FakeChatProvider.stream_chat always emits "Based on the context: ..." —
    # its absence proves stream_chat was never called (no LLM token spend).
    assert "Based on the context" not in res.text
