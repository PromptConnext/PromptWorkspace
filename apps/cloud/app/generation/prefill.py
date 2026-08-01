"""Draft a stage's intake form from the project's own source material.

The Planner asks a human for structured input before `specify` and `plan`
(apps/web/src/components/project/stage-forms.ts) — a dozen-odd fields that a
PRD has usually already answered in prose. This reads that material once and
returns a per-field draft the author reviews and edits, so the form starts
filled rather than blank.

The field list travels *in the request* rather than being duplicated here.
The Planner owns the questions it asks; the cloud only knows how to answer
them against the project's documents, which keeps one source of truth for the
form and means adding a field needs no deploy on this side. Nothing here
touches the graph — a draft is a suggestion, not an artifact.
"""

from __future__ import annotations

from app.generation.parsing import extract_json_object

# A drafted answer is a form field, not a document. The cap is generous for a
# paragraph and still bounds a model that decides to write an essay into one.
MAX_FIELD_CHARS = 2_000

SYSTEM_PROMPT = (
    "You are reading a project's source material to fill in an intake form on the author's "
    "behalf. Answer only from the material you are given.\n"
    "Return a single JSON object and nothing else: keys are exactly the field keys listed "
    "below, values are strings.\n"
    "Rules: use the source's own wording where you can; keep each answer short and concrete "
    "(a sentence or a few lines). If a field asks for a list, put one item per line. If the "
    "material does not answer a field, return an empty string for it — never guess, never "
    "write 'N/A' or 'unknown'. Do not invent technology choices, metrics, or dates that are "
    "not stated."
)


def build_prompt(fields: list[dict[str, str]], context: str) -> str:
    lines = ["FIELDS:"]
    for field in fields:
        hint = f" — {field['hint']}" if field.get("hint") else ""
        lines.append(f"- {field['key']}: {field['label']}{hint}")
    lines += ["", "SOURCE MATERIAL:", context]
    return "\n".join(lines)


def parse_prefill(raw: str, fields: list[dict[str, str]]) -> dict[str, str] | None:
    """Map the completion onto the requested keys. Returns None when there is
    no usable JSON object at all — anything else is normalised: unknown keys
    dropped, non-strings and over-long values coerced, missing keys absent
    (the client leaves those fields alone rather than blanking them)."""
    parsed = extract_json_object(raw)
    if parsed is None:
        return None

    allowed = {field["key"] for field in fields}
    drafted: dict[str, str] = {}
    for key, value in parsed.items():
        if key not in allowed:
            continue
        if isinstance(value, list):
            # "one item per line" is a list to some models.
            value = "\n".join(str(item) for item in value)
        elif not isinstance(value, str):
            value = str(value)
        value = value.strip()[:MAX_FIELD_CHARS]
        if value:
            drafted[key] = value
    return drafted
