"""Question classifier (M10): lineage/status vs. content vs. mixed.

A cheap regex heuristic, deliberately not a model call. Two reasons:

1. The eval harness (tests/test_rag_eval.py) must run deterministically in
   CI against the stub provider — a model-based classifier is either
   untestable deterministically or needs a second fake response wired in,
   for no real benefit at this scale.
2. It would add a full model round-trip (latency + workspace token budget)
   ahead of every chat message. PM status vocabulary is a small, stable,
   lexical set ("done", "status", "how many", ...) — exactly the kind of
   narrow decision a regex heuristic handles instantly and for free.

Defaults to "content" when neither set matches: an unrecognized question
still gets answered via vector search rather than silently guessing status.
"""

from __future__ import annotations

import re
from typing import Literal

Classification = Literal["lineage", "content", "mixed"]

_LINEAGE_MARKERS = re.compile(
    r"\b("
    r"status|progress|done|complete|completed|finished|"
    r"how many|which tasks?|open|blocked|pending|todo|"
    r"in.progress|verified|implemented|assignee|sprint|"
    r"owns?|who is working|is\s+\S.*\s+done"
    r")\b",
    re.IGNORECASE,
)

_CONTENT_MARKERS = re.compile(
    r"\b("
    r"why|how does|explain|what is|describe|"
    r"acceptance criteria|design|approach|architecture"
    r")\b",
    re.IGNORECASE,
)


def classify_question(question: str) -> Classification:
    has_lineage = bool(_LINEAGE_MARKERS.search(question))
    has_content = bool(_CONTENT_MARKERS.search(question))
    if has_lineage and has_content:
        return "mixed"
    if has_lineage:
        return "lineage"
    return "content"
