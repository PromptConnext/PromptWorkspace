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
        self, texts: list[str], model: str, api_key: str, base_url: str
    ) -> list[list[float]]: ...


class HttpEmbeddingProvider:
    async def embed(
        self, texts: list[str], model: str, api_key: str, base_url: str
    ) -> list[list[float]]:
        url = base_url.rstrip("/") + "/embeddings"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                url,
                json={"input": texts, "model": model},
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
        self, texts: list[str], model: str, api_key: str, base_url: str
    ) -> list[list[float]]:
        return [_hash_vector(t, self.dim) for t in texts]


def _hash_vector(text: str, dim: int) -> list[float]:
    digest = hashlib.sha256(text.encode()).digest()
    while len(digest) < dim * 4:
        digest += hashlib.sha256(digest).digest()
    floats = struct.unpack(f"{dim}i", digest[: dim * 4])
    return [f / 2**31 for f in floats]
