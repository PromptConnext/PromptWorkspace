"""Parsing helpers — Python port of the parsing side of the engine's
`runStage()` (apps/engine/src/agent/loop.ts): `parseFiles`, `stripThinking`,
`extractDocument`, `parseTaskLines`. Kept as pure functions so cloud- and
engine-side generation stay behaviorally aligned without sharing runtime.
"""

from __future__ import annotations

import re

_FILE_BLOCK_RE = re.compile(r"```file:([^\n]+)\n(.*?)```", re.DOTALL)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_TASK_LINE_RE = re.compile(r"^\s*[-*] \[[ xX]?\] (T\d+)\s+(\[P\]\s+)?(.+)$")


def parse_files(raw: str) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for m in _FILE_BLOCK_RE.finditer(raw):
        path = m.group(1).strip()
        if ".." in path or path.startswith("/"):
            continue
        files.append({"path": path, "content": m.group(2)})
    return files


def strip_thinking(raw: str) -> str:
    """Thinking models (qwen3, deepseek-r1, ...) prepend reasoning the
    parser must never see."""
    return _THINK_RE.sub("", raw).strip()


def extract_document(raw: str) -> str | None:
    """Fallback for models that write a good document but ignore the
    file-block wrapper: unwrap a plain markdown fence if present, then take
    everything from the first H1 onward."""
    text = raw.strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.split("\n")
        inner = "\n".join(lines[1:-1])
        if len(inner) > len(text) * 0.8:
            text = inner.strip()
    h1 = text.find("\n# ")
    if h1 >= 0 and not text.startswith("# "):
        text = text[h1 + 1 :]
    return text if text.startswith("# ") and len(text) > 80 else None


def parse_task_lines(doc: str) -> list[dict[str, object]]:
    """Pull `- [ ] T001 [P] Description` checklist lines out of a tasks.md."""
    tasks: list[dict[str, object]] = []
    for line in doc.split("\n"):
        m = _TASK_LINE_RE.match(line)
        if m:
            tasks.append(
                {"ref": m.group(1), "title": m.group(3).strip(), "parallel": bool(m.group(2))}
            )
    return tasks
