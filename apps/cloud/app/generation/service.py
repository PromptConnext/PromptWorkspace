"""Generation service (M1, plan 0007): assembles a stage's driver prompt +
retrieved context, streams a completion from the resolved model connection,
and parses the artifact out — the cloud-side equivalent of the engine's
`runStage()` (apps/engine/src/agent/loop.ts), reusing `stream_openai_chat`
(app/rag/chat.py) as the OpenAI-compatible transport.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
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
        self,
        system_prompt: str,
        user_content: str,
        model: str,
        api_key: str,
        base_url: str,
        max_tokens: int | None = None,
        on_finish: Callable[[str | None], None] | None = None,
    ) -> AsyncIterator[str]: ...


class HttpGenerationProvider:
    async def stream(
        self,
        system_prompt: str,
        user_content: str,
        model: str,
        api_key: str,
        base_url: str,
        max_tokens: int | None = None,
        on_finish: Callable[[str | None], None] | None = None,
    ) -> AsyncIterator[str]:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        async for delta in stream_openai_chat(
            messages, model, api_key, base_url, max_tokens=max_tokens, on_finish=on_finish
        ):
            yield delta


class FakeGenerationProvider:
    """Deterministic, network-free provider for tests. Deliberately omits
    the ```file:<path>``` wrapper — it returns a bare `# Title\n\n<body>`
    document, so tests exercise the same extract_document() fallback path a
    real model that ignores the wrapper would hit. For the `tasks` stage
    (detected from the driver prompt's "task-breakdown" role, since the
    provider doesn't otherwise know which stage it's serving) it emits a
    real `- [ ] T001 Description` checklist, each task carrying an `  - AC:`
    criterion, instead of echoing the prompt, so parse_task_lines() has
    something to parse. Prefill requests (detected
    the same way, from the intake-form system prompt) get a JSON object keyed
    by the requested fields, each value quoting the source material so tests
    can tell a grounded draft from an invented one."""

    def __init__(self, title: str = "Generated Title", finish_reason: str | None = "stop") -> None:
        self._title = title
        self._finish_reason = finish_reason

    async def stream(
        self,
        system_prompt: str,
        user_content: str,
        model: str,
        api_key: str,
        base_url: str,
        max_tokens: int | None = None,
        on_finish: Callable[[str | None], None] | None = None,
    ) -> AsyncIterator[str]:
        if "intake form" in system_prompt:
            doc = json.dumps(_fake_prefill(user_content))
        elif "task-breakdown" in system_prompt:
            doc = (
                f"# {self._title}\n\n"
                "- [ ] T001 [P] Implement the first task from the plan\n"
                "  - AC: The first task's behaviour is observable\n"
                "- [ ] T002 Implement the second task from the plan\n"
                "  - AC: The second task's behaviour is observable\n"
            )
        else:
            doc = f"# {self._title}\n\n{user_content}"
        for word in doc.split(" "):
            yield word + " "
        if on_finish is not None:
            on_finish(self._finish_reason)


def _fake_prefill(user_content: str) -> dict[str, str]:
    """Read the field keys back out of the prompt build_prompt() produced and
    answer each with a slice of the source material it was given."""
    keys: list[str] = []
    source: list[str] = []
    section = None
    for line in user_content.split("\n"):
        if line.startswith("FIELDS:"):
            section = "fields"
        elif line.startswith("SOURCE MATERIAL:"):
            section = "source"
        elif section == "fields" and line.startswith("- "):
            keys.append(line[2:].split(":", 1)[0].strip())
        elif section == "source" and line.strip():
            source.append(line.strip())
    excerpt = " ".join(source)[:400]
    return {key: f"drafted from source: {excerpt}" for key in keys}


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
