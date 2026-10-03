"""Parsing helpers — Python port of the parsing side of the engine's
`runStage()` (apps/engine/src/agent/loop.ts): `parseFiles`, `stripThinking`,
`extractDocument`, `parseTaskLines`. Kept as pure functions so cloud- and
engine-side generation stay behaviorally aligned without sharing runtime.
"""

from __future__ import annotations

import json
import re

_FILE_BLOCK_RE = re.compile(r"```file:([^\n]+)\n(.*?)```", re.DOTALL)
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_TASK_LINE_RE = re.compile(r"^\s*[-*] \[[ xX]?\] (T\d+)\s+(\[P\]\s+)?(.+)$")
# An indented `- AC: <criterion>` sub-bullet under a task line.
_TASK_AC_RE = re.compile(r"^[ \t]+[-*]\s+(?:AC|Acceptance)\s*:\s*(.*?)\s*$", re.IGNORECASE)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->\n?", re.DOTALL)
_SPECKIT_MARKER_LINE_RE = re.compile(r"^.*__SPECKIT_COMMAND_[A-Z]+__.*\n?", re.MULTILINE)


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


def strip_template_scaffolding(doc: str) -> str:
    """Models sometimes echo the driver template's authoring guidance back
    into the generated document instead of treating it as instructions:
    HTML comments (`<!-- ACTION REQUIRED: ... -->`) and lines carrying a
    `__SPECKIT_COMMAND_*__` marker (e.g. the template's own "Note: this
    file is filled in by ..." line). Strip both deterministically rather
    than relying solely on prompt compliance from weaker models."""
    text = _HTML_COMMENT_RE.sub("", doc)
    text = _SPECKIT_MARKER_LINE_RE.sub("", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_json_object(raw: str) -> dict | None:
    """Pull the first JSON object out of a completion. Models wrap JSON in a
    ```json fence, prefix it with "Here you go:", or both — asking nicely in
    the prompt is not a guarantee, so take the outermost braces and parse
    those. Returns None when there is no object or it doesn't parse."""
    text = strip_thinking(raw)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def parse_task_lines(doc: str) -> list[dict[str, object]]:
    """Pull `- [ ] T001 [P] Description` checklist lines out of a tasks.md,
    each with the indented `  - AC: <criterion>` sub-bullets beneath it as
    `acceptance_criteria` (empty when it has none). Other sub-bullets, and an
    AC line before the first task, are ignored."""
    tasks: list[dict[str, object]] = []
    criteria: list[str] | None = None
    for line in doc.split("\n"):
        m = _TASK_LINE_RE.match(line)
        if m:
            criteria = []
            tasks.append(
                {
                    "ref": m.group(1),
                    "title": m.group(3).strip(),
                    "parallel": bool(m.group(2)),
                    "acceptance_criteria": criteria,
                }
            )
            continue
        ac = _TASK_AC_RE.match(line)
        if ac and ac.group(1) and criteria is not None:
            criteria.append(ac.group(1))
    return tasks
