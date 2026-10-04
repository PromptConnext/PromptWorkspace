"""Text extraction, dispatched by MIME (M0, plan 0007).

Markdown/plain text is a passthrough (front-matter stripped). PDFs try the
text layer first (`pypdf`); a born-digital PDF stops there. A scanned/
image-only PDF yields near-empty text-layer output, so extraction falls back
to the OCR provider (app/documents/ocr.py) — the caller records which path
ran via `ExtractionResult.method`.

Every path strips U+0000 before returning: Postgres `text` cannot store it, so
one stray NUL from a text file, a PDF string escape or an OCR provider would
otherwise fail the extraction write.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from pypdf import PdfReader

from app.documents.ocr import OcrProvider

ALLOWED_MIMES = ("text/markdown", "text/plain", "application/pdf")

# Below this many non-whitespace characters, a PDF's text layer is treated as
# absent (scanned/image-only) rather than merely short.
_MIN_TEXT_LAYER_CHARS = 20

_FRONT_MATTER_RE = re.compile(r"\A---\n.*?\n---\n?", re.DOTALL)


@dataclass(frozen=True)
class ExtractionResult:
    text: str
    method: Literal["passthrough", "text_layer", "ocr"]


class UnsupportedMimeError(ValueError):
    def __init__(self, mime: str) -> None:
        super().__init__(f"unsupported_mime:{mime}")
        self.mime = mime


async def extract_text(mime: str, content: bytes, ocr_provider: OcrProvider) -> ExtractionResult:
    if mime not in ALLOWED_MIMES:
        raise UnsupportedMimeError(mime)

    if mime in ("text/markdown", "text/plain"):
        text = _FRONT_MATTER_RE.sub("", content.decode("utf-8", errors="replace"))
        return ExtractionResult(text=_clean(text), method="passthrough")

    text_layer = _extract_pdf_text_layer(content)
    if len(text_layer.strip()) >= _MIN_TEXT_LAYER_CHARS:
        return ExtractionResult(text=_clean(text_layer), method="text_layer")

    ocr_text = await ocr_provider.extract_text(content)
    return ExtractionResult(text=_clean(ocr_text), method="ocr")


def _clean(text: str) -> str:
    return text.replace("\x00", "").strip()


def _extract_pdf_text_layer(content: bytes) -> str:
    import io

    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)
