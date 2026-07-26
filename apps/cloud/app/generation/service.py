"""Generation service (M1, plan 0007): assembles a stage's driver prompt +
retrieved context, streams a completion from the resolved model connection,
and parses the artifact out — the cloud-side equivalent of the engine's
`runStage()` (apps/engine/src/agent/loop.ts), reusing `stream_openai_chat`
(app/rag/chat.py) as the OpenAI-compatible transport.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from app.generation.parsing import (
    extract_document,
    parse_files,
    strip_template_scaffolding,
    strip_thinking,
)
from app.generation.prompts import STAGE_OUTPUT_PATH, StageKind
from app.rag.chat import stream_openai_chat


class GenerationProvider(Protocol):
    def stream(
        self, system_prompt: str, user_content: str, model: str, api_key: str, base_url: str
    ) -> AsyncIterator[str]: ...


class HttpGenerationProvider:
    async def stream(
        self, system_prompt: str, user_content: str, model: str, api_key: str, base_url: str
    ) -> AsyncIterator[str]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        async for delta in stream_openai_chat(messages, model, api_key, base_url):
            yield delta


class FakeGenerationProvider:
    """Deterministic, network-free provider for tests. Deliberately omits
    the ```file:<path>``` wrapper — it returns a bare `# Title\n\n<body>`
    document, so tests exercise the same extract_document() fallback path a
    real model that ignores the wrapper would hit. For the `tasks` stage
    (detected from the driver prompt's "task-breakdown" role, since the
    provider doesn't otherwise know which stage it's serving) it emits a
    real `- [ ] T001 Description` checklist instead of echoing the prompt,
    so parse_task_lines() has something to parse."""

    def __init__(self, title: str = "Generated Title") -> None:
        self._title = title

    async def stream(
        self, system_prompt: str, user_content: str, model: str, api_key: str, base_url: str
    ) -> AsyncIterator[str]:
        if "task-breakdown" in system_prompt:
            doc = (
                f"# {self._title}\n\n"
                "- [ ] T001 [P] Implement the first task from the plan\n"
                "- [ ] T002 Implement the second task from the plan\n"
            )
        else:
            doc = f"# {self._title}\n\n{user_content}"
        for word in doc.split(" "):
            yield word + " "


class GenerationError(ValueError):
    pass


@dataclass(frozen=True)
class GenerationResult:
    stage: StageKind
    title: str
    content: str
    path: str
    raw: str


def build_user_content(user_input: str, context: str) -> str:
    return f"{user_input}\n\nCONTEXT:\n{context}" if context else user_input


def parse_stage_output(kind: StageKind, user_input: str, raw: str) -> GenerationResult:
    """Pure parsing step, split out from the streaming call so the caller
    (app/api/generation.py) can `yield` each delta to the client as it
    arrives — the same inline-streaming shape as assistant.chat — and only
    parse once the full completion is in hand."""
    cleaned = strip_thinking(raw)
    files = parse_files(cleaned)
    if files:
        path, content = files[0]["path"], files[0]["content"]
    else:
        doc = extract_document(cleaned)
        if doc is None:
            raise GenerationError(
                "model output contained neither file blocks nor a recognizable markdown document"
            )
        path, content = STAGE_OUTPUT_PATH[kind], doc

    content = strip_template_scaffolding(content)
    first_line = next((line for line in content.split("\n") if line.startswith("# ")), None)
    title = first_line.removeprefix("# ").strip() if first_line else user_input[:80]
    return GenerationResult(stage=kind, title=title, content=content, path=path, raw=raw)
