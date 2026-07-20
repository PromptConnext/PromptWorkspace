"""Document source seam (M0, plan 0007).

`upload` is the only implementation in the pilot: a multipart file the caller
already has in hand. The protocol exists so a future Figma MCP adapter can
pull selected frames/nodes as structured text and feed the *same*
extract -> embed path — that adapter is explicitly deferred, only the seam
ships now.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class DocumentSource(Protocol):
    source_kind: str
    mime: str

    async def fetch(self) -> bytes: ...


@dataclass
class UploadSource:
    """Wraps bytes already read from a multipart request body."""

    content: bytes
    mime: str
    source_kind: str = "upload"

    async def fetch(self) -> bytes:
        return self.content
