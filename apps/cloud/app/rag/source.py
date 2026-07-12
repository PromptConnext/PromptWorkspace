"""Node -> embeddable text. v1 (M9) sources: requirements, spec_documents,
tasks. M10 kept this list extensible by design; M11 adds pull_requests —
PR title/description, an explicitly-named indexable source in ADR 0011 (not
source code, so the "no source at rest" rule doesn't apply to it). Code
itself is never routed through this function — it has its own no-content
pipeline (app/rag/code_chunker.py + Repository.upsert_code_chunks), since
code must never be persisted as text at all, even transiently in a queue
job's node_text() result.

Discussion doesn't exist as an entity yet and Artifact carries no content
field, so both remain out of scope (deferred to M12, see plan 0005)."""

from __future__ import annotations

from app.models.schemas import GraphEntity, PullRequest, Requirement, SpecDocument, Task

RAG_NODE_TYPES = ("requirements", "spec_documents", "tasks", "pull_requests")


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
    return ""
