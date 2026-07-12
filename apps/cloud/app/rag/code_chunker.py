"""Line-based code chunking (M11) — unlike app/rag/chunker.py's word-count
chunking (fine for prose), code chunks need line ranges so citations can
link to an exact Git-host location. Pure text in, tuples out — the caller
(app/rag/queue.py) is responsible for never persisting the chunk text
itself, only the line range and its embedding (ADR 0011: no source at rest).
"""

from __future__ import annotations


def chunk_code(
    text: str, lines_per_chunk: int = 80, overlap: int = 10
) -> list[tuple[str, int, int]]:
    """Returns (chunk_text, start_line, end_line) — 1-indexed, inclusive,
    matching GitHub's own line-anchor convention (#L{start}-L{end})."""
    lines = text.splitlines()
    if not lines:
        return []
    chunks: list[tuple[str, int, int]] = []
    start = 0
    step = max(1, lines_per_chunk - overlap)
    while start < len(lines):
        end = min(start + lines_per_chunk, len(lines))
        chunks.append(("\n".join(lines[start:end]), start + 1, end))
        if end >= len(lines):
            break
        start += step
    return chunks
