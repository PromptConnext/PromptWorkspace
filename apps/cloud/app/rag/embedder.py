"""Embedding providers. BYO at the workspace level: `base_url` + `api_key`
come from the workspace's model connection, not this module — it only knows
how to *speak* the OpenAI-compatible `/embeddings` shape, which OpenAI,
Azure OpenAI, Ollama, and most self-hosted gateways all support.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Protocol

import httpx


class EmbeddingProvider(Protocol):
    async def embed(
        self,
        texts: list[str],
        model: str,
        api_key: str,
        base_url: str,
        dim: int | None = None,
    ) -> list[list[float]]: ...


class HttpEmbeddingProvider:
    async def embed(
        self,
        texts: list[str],
        model: str,
        api_key: str,
        base_url: str,
        dim: int | None = None,
    ) -> list[list[float]]:
        url = base_url.rstrip("/") + "/embeddings"
        payload: dict[str, object] = {"input": texts, "model": model}
        # `dimensions` is sent only when the connection configures one. Some
        # models return a width that does not fit pw_rag_chunks.embedding
        # unless asked to truncate — Gemini's gemini-embedding-001 defaults to
        # 3072 and supports MRL truncation to 1536, and OpenAI's
        # text-embedding-3-* accept the same parameter. It is deliberately
        # omitted when unset, because self-hosted gateways (Ollama, TEI) may
        # reject an unknown field outright.
        if dim is not None:
            payload["dimensions"] = dim
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            data = resp.json()["data"]
            return [row["embedding"] for row in data]


class FakeEmbeddingProvider:
    """Deterministic, network-free provider for tests. Cosine similarity over
    these vectors is meaningless as "relevance" but is stable and repeatable,
    which is all retrieval-plumbing tests need."""

    dim = 32

    async def embed(
        self,
        texts: list[str],
        model: str,
        api_key: str,
        base_url: str,
        dim: int | None = None,
    ) -> list[list[float]]:
        # The requested width is accepted and ignored: these vectors are for
        # plumbing tests, where a stable 32-wide hash is the point.
        return [_hash_vector(t, self.dim) for t in texts]


def _hash_vector(text: str, dim: int) -> list[float]:
    digest = hashlib.sha256(text.encode()).digest()
    while len(digest) < dim * 4:
        digest += hashlib.sha256(digest).digest()
    floats = struct.unpack(f"{dim}i", digest[: dim * 4])
    return [f / 2**31 for f in floats]
