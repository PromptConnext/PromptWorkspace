"""`HttpEmbeddingProvider`'s request shape.

The `dimensions` parameter is load-bearing for any model whose native width
does not match pw_rag_chunks.embedding's fixed vector(1536): Gemini's
gemini-embedding-001 returns 3072 by default and must be asked to truncate,
or every insert fails. It is equally load-bearing that the field is *absent*
when unconfigured, since self-hosted gateways (Ollama, TEI) may reject an
unknown field outright.

There is no pytest asyncio plugin in this suite, so each test drives the
coroutine through `asyncio.run` itself, with httpx.MockTransport standing in
for the embeddings API — same shape as test_github_contents_upsert.py.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.rag.embedder import HttpEmbeddingProvider


@pytest.fixture
def transport(monkeypatch):
    """Routes every httpx.AsyncClient in the module under test at a fake
    embeddings endpoint. Returns the list of recorded requests."""
    recorder: list[dict] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        recorder.append(
            {
                "url": str(request.url),
                "auth": request.headers.get("authorization"),
                "payload": json.loads(request.content),
            }
        )
        return httpx.Response(200, json={"data": [{"embedding": [0.1, 0.2, 0.3]}]})

    def factory(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return recorder


def test_sends_dimensions_when_configured(transport):
    asyncio.run(
        HttpEmbeddingProvider().embed(
            ["hello"],
            "gemini-embedding-001",
            "key-123",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            1536,
        )
    )

    sent = transport[0]
    assert sent["payload"]["dimensions"] == 1536
    assert sent["payload"]["model"] == "gemini-embedding-001"
    assert sent["payload"]["input"] == ["hello"]
    assert sent["auth"] == "Bearer key-123"
    assert sent["url"] == "https://generativelanguage.googleapis.com/v1beta/openai/embeddings"


def test_omits_dimensions_when_not_configured(transport):
    asyncio.run(
        HttpEmbeddingProvider().embed(["hello"], "bge-m3", "k", "http://localhost:11434/v1")
    )

    assert "dimensions" not in transport[0]["payload"]


def test_strips_trailing_slash_from_base_url(transport):
    asyncio.run(HttpEmbeddingProvider().embed(["hello"], "m", "k", "https://example.com/v1/", 1536))

    assert transport[0]["url"] == "https://example.com/v1/embeddings"
