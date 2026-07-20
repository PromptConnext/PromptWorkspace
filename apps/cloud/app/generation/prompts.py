"""Stage driver prompts (M1, plan 0007) — Python port of the engine's
`driverPrompt()` (apps/engine/src/agent/loop.ts). Template text is copied
verbatim into `app/generation/templates/` so cloud- and engine-generated
artifacts stay consistent; only the prompt wrapper differs (a system message
here, a chat message there), matching the plan's "keep the template text
identical" instruction.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

StageKind = Literal["constitution", "specify", "plan", "tasks"]

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

_STAGE_TEMPLATE: dict[StageKind, str] = {
    "constitution": "constitution-template.md",
    "specify": "spec-template.md",
    "plan": "plan-template.md",
    "tasks": "tasks-template.md",
}

_STAGE_ROLE: dict[StageKind, str] = {
    "constitution": "project-constitution",
    "specify": "specification",
    "plan": "implementation-planning",
    "tasks": "task-breakdown",
}

# Mirrors loop.ts's STAGES[...].outPath — the fallback path used when a model
# writes a good document but ignores the ```file:<path>``` wrapper.
STAGE_OUTPUT_PATH: dict[StageKind, str] = {
    "constitution": ".specify/memory/constitution.md",
    "specify": "specs/001/spec.md",
    "plan": "specs/001/plan.md",
    "tasks": "specs/001/tasks.md",
}


def _template(name: str) -> str:
    return (_TEMPLATES_DIR / name).read_text(encoding="utf-8")


def driver_prompt(kind: StageKind) -> str:
    doc = _template(_STAGE_TEMPLATE[kind])
    lines = [
        f"You are the {_STAGE_ROLE[kind]} engine inside PromptConnext.",
        "Fill in the following template completely, based on the user's input. Replace every "
        "placeholder. Do not leave template markers like [FEATURE NAME] or $ARGUMENTS in the "
        "output. Mark genuine unknowns with [NEEDS CLARIFICATION: question].",
    ]
    if kind == "tasks":
        lines.append(
            "Every task line MUST keep the exact checklist shape `- [ ] T001 [P] Description` "
            "([P] only when parallelizable) so the platform can ingest it."
        )
    lines += [
        "",
        "TEMPLATE:",
        doc,
        "",
        "OUTPUT FORMAT (mandatory): return each file as a fenced block that starts with "
        f"```file:<relative-path> and ends with ```. Produce exactly one file at "
        f"{STAGE_OUTPUT_PATH[kind]}. The first line of the file must be a markdown H1 title. "
        "No prose outside the fenced block.",
    ]
    return "\n".join(lines)
