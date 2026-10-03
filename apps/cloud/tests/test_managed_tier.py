"""Managed Typhoon tier (M2, plan 0007) — exit criteria under test:

  1. A workspace with no BYO model connection generates through the managed
     source instead of 400ing.
  2. The platform key is used — never a per-workspace one (there isn't one
     to leak here: the workspace has no model-connection row at all).
  3. An upstream 429 maps to a typed, retryable error (never a silent
     failure or a raw 500).
  4. The per-workspace daily budget is enforced for the managed source too.
"""

from __future__ import annotations

import json
import logging

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}

PLATFORM_KEY = "sk-platform-typhoon-key-should-never-leak"

# Long enough to clear generation.parsing.extract_document's 80-char floor.
CONSTITUTION_INPUT = "Ship fast, keep it simple, and always write tests before merging any change."

_SSE_DONE_PREFIX = "event: done\ndata: "
_SSE_ERROR_PREFIX = "event: error\ndata: "


def _sse_events(body: str) -> dict[str, dict]:
    events: dict[str, dict] = {}
    current_event = "message"
    for line in body.splitlines():
        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            payload = line[len("data:") :].strip()
            if payload:
                events[current_event] = json.loads(payload)
    return events


class RecordingGenerationProvider:
    """Records the api_key it was called with; returns a real document so
    the parser succeeds."""

    def __init__(self, finish_reason: str | None = "stop") -> None:
        self.received_api_key: str | None = None
        self.received_max_tokens: int | None = None
        self._finish_reason = finish_reason

    async def stream(
        self,
        system_prompt,
        user_content,
        model,
        api_key,
        base_url,
        max_tokens=None,
        on_finish=None,
    ):
        self.received_api_key = api_key
        self.received_max_tokens = max_tokens
        doc = f"# Managed Constitution\n\n{user_content}"
        for word in doc.split(" "):
            yield word + " "
        if on_finish is not None:
            on_finish(self._finish_reason)


class RateLimitedGenerationProvider:
    """Simulates the free Typhoon API throttling this request upstream."""

    async def stream(
        self,
        system_prompt,
        user_content,
        model,
        api_key,
        base_url,
        max_tokens=None,
        on_finish=None,
    ):
        request = httpx.Request("POST", f"{base_url}/chat/completions")
        response = httpx.Response(429, request=request)
        if True:  # keeps this function a generator; the raise below always fires
            raise httpx.HTTPStatusError("rate limited", request=request, response=response)
        yield ""  # pragma: no cover - unreachable


def _managed_connection(daily_token_budget: int = 20_000) -> ModelConnection:
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


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        # Real MemorySecretStore.decrypt(secret_ref) would choke on
        # "unused-in-these-tests" — tests here only care that the provider
        # receives the platform key, so stub decrypt() to hand it back
        # directly regardless of secret_ref.
        c.app.state.secret_store.decrypt = lambda _ref: PLATFORM_KEY
        yield c


def _bootstrap_workspace_with_no_model_connection(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_managed_source_selected_when_no_byo_connection(client: TestClient):
    _ws_id, pid = _bootstrap_workspace_with_no_model_connection(client)
    client.app.state.managed_connection = _managed_connection()
    provider = RecordingGenerationProvider()
    client.app.state.generation_provider = provider

    res = client.post(
        f"/projects/{pid}/generate/constitution",
        json={"user_input": CONSTITUTION_INPUT},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "content" in events["done"]

    repo = client.app.state.repository
    runs = list(repo._generation_runs.values())  # test-only reach into InMemoryRepository internals
    assert any(r.project_id == pid and r.model_source == "managed" for r in runs)


def test_platform_key_never_from_workspace_row(client: TestClient):
    ws_id, pid = _bootstrap_workspace_with_no_model_connection(client)
    client.app.state.managed_connection = _managed_connection()
    provider = RecordingGenerationProvider()
    client.app.state.generation_provider = provider

    # No model-connection row exists for this workspace at all — proves the
    # key genuinely can't have come from one.
    assert client.app.state.repository.get_model_connection(ws_id) is None

    res = client.post(
        f"/projects/{pid}/generate/constitution",
        json={"user_input": CONSTITUTION_INPUT},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert provider.received_api_key == PLATFORM_KEY


def test_upstream_429_maps_to_retryable_error(client: TestClient):
    _ws_id, pid = _bootstrap_workspace_with_no_model_connection(client)
    client.app.state.managed_connection = _managed_connection()
    client.app.state.generation_provider = RateLimitedGenerationProvider()

    res = client.post(
        f"/projects/{pid}/generate/constitution",
        json={"user_input": CONSTITUTION_INPUT},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text  # SSE stream itself opens fine
    events = _sse_events(res.text)
    assert events["error"]["retryable"] is True
    assert "managed tier busy" in events["error"]["error"]


def test_managed_daily_budget_enforced(client: TestClient):
    _ws_id, pid = _bootstrap_workspace_with_no_model_connection(client)
    client.app.state.managed_connection = _managed_connection(daily_token_budget=0)
    client.app.state.generation_provider = RecordingGenerationProvider()

    res = client.post(
        f"/projects/{pid}/generate/constitution",
        json={"user_input": CONSTITUTION_INPUT},
        headers=ALICE,
    )
    assert res.status_code == 429


def test_global_managed_limiter_protects_shared_key(client: TestClient):
    """Load-test-shaped check for the exit criterion: hammering the managed
    source across many workspaces trips the *global* limiter well before
    each workspace's own daily budget would."""
    client.app.state.managed_connection = _managed_connection()
    client.app.state.generation_provider = RecordingGenerationProvider()
    client.app.state.managed_limiter._buckets.clear()

    statuses = []
    for _ in range(20):
        _ws_id, pid = _bootstrap_workspace_with_no_model_connection(client)
        res = client.post(
            f"/projects/{pid}/generate/constitution",
            json={"user_input": CONSTITUTION_INPUT},
            headers=ALICE,
        )
        statuses.append(res.status_code)

    assert any(s == 429 for s in statuses), "global limiter never engaged across 20 rapid requests"


# --------------------------------------------------------------------------- #
# Startup warning when the managed tier is on but embeddings aren't
# configured (plan 0008 follow-up) — this combination means every content
# question in every keyless workspace silently returns "no matching
# artifacts" with no retrieval attempted, which is worth shouting about at
# startup rather than only surfacing in a settings form nobody visits when
# the symptom is a bad chat answer.
# --------------------------------------------------------------------------- #

_MISSING_EMBED_WARNING = "Managed embeddings are not configured"


@pytest.fixture
def _clean_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_startup_warns_when_managed_tier_on_but_embed_unconfigured(
    monkeypatch, caplog, _clean_settings_cache
):
    monkeypatch.setenv("MANAGED_MODEL_ENABLED", "true")
    monkeypatch.setenv("MANAGED_MODEL_API_KEY", "sk-platform-key")
    monkeypatch.delenv("MANAGED_EMBED_BASE_URL", raising=False)
    monkeypatch.delenv("MANAGED_EMBED_MODEL", raising=False)

    app = create_app()
    with caplog.at_level(logging.WARNING, logger="promptworkspace"):
        with TestClient(app):
            pass

    assert any(_MISSING_EMBED_WARNING in record.message for record in caplog.records)


def test_startup_silent_about_embeddings_when_managed_tier_off(
    monkeypatch, caplog, _clean_settings_cache
):
    monkeypatch.setenv("MANAGED_MODEL_ENABLED", "false")
    monkeypatch.delenv("MANAGED_MODEL_API_KEY", raising=False)
    monkeypatch.delenv("MANAGED_EMBED_BASE_URL", raising=False)
    monkeypatch.delenv("MANAGED_EMBED_MODEL", raising=False)

    app = create_app()
    with caplog.at_level(logging.WARNING, logger="promptworkspace"):
        with TestClient(app):
            pass

    assert not any(_MISSING_EMBED_WARNING in record.message for record in caplog.records)
