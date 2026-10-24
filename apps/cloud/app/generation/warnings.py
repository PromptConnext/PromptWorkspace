"""The parse warnings a stage document is reported against.

Shared by the managed-model generation route (app/api/generation.py) and the
agent stage-draft submit route (app/api/stage_drafts.py), so a draft the
importer's agent writes is held to the same checks a generated one is.
Warnings are reported, never acted on: the document is stored as written.
"""

from __future__ import annotations

from typing import Any

from app.generation.parsing import (
    fix_template_placeholders,
    missing_task_refs,
    parse_task_lines,
    strip_spec_kit_boilerplate,
    strip_template_scaffolding,
    strip_thinking,
)
from app.generation.path_check import unknown_task_paths
from app.generation.service import GenerationError, parse_stage_output
from app.models.schemas import RepoAnalysis


def _parsed_content(stage: str, markdown: str) -> str:
    """What `parse_stage_output` keeps of the document. A document it cannot
    recognise (no H1, or a short one) still gets the same cleaning, so the
    question "is anything left?" has one answer either way."""
    try:
        return parse_stage_output(stage, "", markdown).content  # type: ignore[arg-type]
    except GenerationError:
        return strip_spec_kit_boilerplate(
            fix_template_placeholders(strip_template_scaffolding(strip_thinking(markdown)))
        )


def stage_warnings(
    stage: str, markdown: str, codebase: RepoAnalysis | None
) -> list[dict[str, Any]]:
    """The warnings for one stage document, in a fixed order.

    `codebase` is the project's analysis when the stages may read it (a
    baseline exists; see app/api/generation.py::_codebase_context), else None;
    it is what `unmarked_new_paths` checks task paths against.

    - `empty_document` (any stage): nothing is left once parsing strips
      thinking, scaffolding and boilerplate. Reported alone.
    - `no_task_lines` (tasks): no `- [ ] T001 title` line parses.
    - `missing_task_numbers` (tasks): gaps in the task numbering.
    - `unmarked_new_paths` (tasks): paths neither in the repository nor
      marked `(new)`, only when the stored listing is complete.
    """
    if not _parsed_content(stage, markdown).strip():
        return [{"code": "empty_document", "items": []}]
    if stage != "tasks":
        return []

    warnings: list[dict[str, Any]] = []
    tasks = parse_task_lines(markdown)
    if not tasks:
        warnings.append({"code": "no_task_lines", "items": []})
    gaps = missing_task_refs([t["ref"] for t in tasks])
    if gaps:
        warnings.append({"code": "missing_task_numbers", "items": gaps})
    if codebase is not None:
        snapshot = codebase.snapshot
        unknown = unknown_task_paths(
            markdown,
            snapshot.paths,
            listing_complete=(
                not snapshot.tree_truncated and snapshot.file_count <= len(snapshot.paths)
            ),
        )
        if unknown:
            # Reported, never rewritten: what a path was meant to be is the
            # author's call.
            warnings.append(
                {
                    "code": "unmarked_new_paths",
                    "items": [{"ref": u.ref, "path": u.path} for u in unknown],
                }
            )
    return warnings
