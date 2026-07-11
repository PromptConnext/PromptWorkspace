"""Pure text chunking — no model calls, easy to unit test in isolation."""

from __future__ import annotations


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """Word-count chunking with overlap. ~500 words approximates the plan's
    ~500-token target closely enough without pulling in a tokenizer dep."""
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    start = 0
    step = max(1, chunk_size - overlap)
    while start < len(words):
        end = start + chunk_size
        chunks.append(" ".join(words[start:end]))
        if end >= len(words):
            break
        start += step
    return chunks
