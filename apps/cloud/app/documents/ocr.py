"""OCR provider seam for scanned/image PDFs (M0, plan 0007).

ADR 0013 earmarks `typhoon-ocr` (via the managed Typhoon source) as the OCR
backend once M2 stands up the managed tier — it's the same OpenAI-compatible
boundary every other model call in this app uses, so no new client is needed
then. For M0 this is a stub: the provider interface exists so `extract.py`'s
fallback path is real and testable today, but no HTTP call is wired until the
managed tier exists. Calling the stub in production is a configuration bug,
not a silent no-op — it raises.
"""

from __future__ import annotations

from typing import Protocol


class OcrProvider(Protocol):
    async def extract_text(self, pdf_bytes: bytes) -> str: ...


class StubOcrProvider:
    """Placeholder used until M2 wires the managed `typhoon-ocr` source."""

    async def extract_text(self, pdf_bytes: bytes) -> str:
        raise NotImplementedError(
            "ocr_not_configured: typhoon-ocr fallback ships in M2 (managed tier)"
        )


class FakeOcrProvider:
    """Deterministic, network-free provider for tests."""

    def __init__(self, text: str = "Fake OCR extracted text.") -> None:
        self._text = text
        self.calls = 0

    async def extract_text(self, pdf_bytes: bytes) -> str:
        self.calls += 1
        return self._text
