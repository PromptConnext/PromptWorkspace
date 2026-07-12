"""Node -> embeddable text. v1 (M9) sources: requirements, spec_documents,
tasks. M10 kept this list extensible by design; M11 adds pull_requests —
PR title/description, an explicitly-named indexable source in ADR 0011 (not
source code, so the "no source at rest" rule doesn't apply to it). Code
itself is never routed through this function — it has its own no-content
pipeline (app/rag/code_chunker.py + Repository.upsert_code_chunks), since
code must never be persisted as text at all, even transiently in a queue
job's node_text() result.

M12 adds discussions — comment body text. Whether a discussion is actually
embedded is a separate decision from what node_text() returns: a pmo-sourced
(Jira-mirrored) discussion still has real text here, but
app/rag/queue.py::_process_job skips embedding it unless the workspace has
opted in (ADR 0011: third-party content defaults out). node_text() itself
stays source-agnostic — it just extracts text, it doesn't gate on policy.

Artifact carries no content field — this is a **deliberate, permanent**
exclusion (M12 closes the gap this docstring used to flag as open), not a
placeholder for a future field:
  - kind="pr" artifacts already have their real text in a separate
    PullRequest row (M11) — the Artifact row is just the graph-visible
    pointer to it.
  - kind="code" artifacts must NEVER carry embeddable text at all; adding one
    would reintroduce "source code at rest," the exact posture M11's
    separate no-content code-chunk pipeline exists to avoid.
  - kind="doc"/"other" artifacts have no current producer of body text —
    nothing writes one today, so there is nothing to extract.
"""

from __future__ import annotations

from app.models.schemas import (
    Discussion,
    GraphEntity,
    PullRequest,
    Requirement,
    SpecDocument,
    Task,
)

RAG_NODE_TYPES = ("requirements", "spec_documents", "tasks", "pull_requests", "discussions")


def node_text(node_type: str, node: GraphEntity | PullRequest) -> str:
    if node_type == "requirements" and isinstance(node, Requirement):
        return f"{node.title}\n\n{node.description}".strip()
    if node_type == "spec_documents" and isinstance(node, SpecDocument):
        return node.content.strip()
    if node_type == "tasks" and isinstance(node, Task):
        criteria = "\n".join(f"- {c.text}" for c in node.acceptance_criteria)
        return f"{node.title}\n\n{criteria}".strip()
    if node_type == "pull_requests" and isinstance(node, PullRequest):
        return f"{node.title}\n\n{node.body}".strip()
    if node_type == "discussions" and isinstance(node, Discussion):
        return node.body.strip()
    return ""
