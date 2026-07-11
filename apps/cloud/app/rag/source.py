"""Node -> embeddable text. v1 sources: requirements, spec_documents, tasks
only — Discussion doesn't exist as an entity yet and Artifact carries no
content field, so both are out of scope for this milestone (see plan 0005 M9
follow-up note)."""

from __future__ import annotations

from app.models.schemas import GraphEntity, Requirement, SpecDocument, Task

RAG_NODE_TYPES = ("requirements", "spec_documents", "tasks")


def node_text(node_type: str, node: GraphEntity) -> str:
    if node_type == "requirements" and isinstance(node, Requirement):
        return f"{node.title}\n\n{node.description}".strip()
    if node_type == "spec_documents" and isinstance(node, SpecDocument):
        return node.content.strip()
    if node_type == "tasks" and isinstance(node, Task):
        criteria = "\n".join(f"- {c.text}" for c in node.acceptance_criteria)
        return f"{node.title}\n\n{criteria}".strip()
    return ""
