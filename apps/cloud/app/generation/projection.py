"""Project a hand-edited stage document onto the task graph.

The generation endpoint (app/api/generation.py) lands `specify` on a
Requirement and `plan` on a SpecDocument, and the stages downstream of them
gate on those rows existing. The markdown side store (app/api/stage_documents.py)
had no such projection, so a document written or pasted straight into the
Planner's editor left the graph empty — and the next stage answered 409
`requirement_required` for a project whose specification was plainly right
there on screen. This closes that gap: an edit updates the same entity a
generation would have created.

Deliberately narrow:

* `constitution` has no graph entity at all (see app/api/generation.py's
  module docstring).
* `tasks` is left to generation. Its projection *parses* the checklist into
  one Task row per line, and a Save fires on every edit — re-parsing here
  would fork the task list on each keystroke-save, and silently orphan the
  status/assignee already on the existing rows. Editing the tasks markdown by
  hand therefore changes the document, not the board; regenerate to rebuild it.
* An empty document projects nothing. Clearing the editor is not a request to
  create a titleless Requirement.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.models.schemas import (
    GraphUpsertRequest,
    Project,
    Requirement,
    RequirementStatus,
    SpecDocument,
)

_TITLE_FALLBACK = "Untitled specification"


def markdown_title(content: str, fallback: str = _TITLE_FALLBACK) -> str:
    """First H1, matching how parse_stage_output titles a generated document."""
    for line in content.split("\n"):
        if line.startswith("# "):
            return line.removeprefix("# ").strip() or fallback
    return fallback


def _summary(content: str) -> str:
    """First prose line, used as a Requirement description when a hand-written
    document creates one — generated documents get the author's own prompt
    there instead, which an editor edit doesn't have."""
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped[:500]
    return ""


def project_stage_document(
    repo: Repository, project: Project, stage: str, content: str
) -> str | None:
    """Create or update the graph entity behind an edited stage document.

    Returns the entity id it touched, or None when the stage has nothing to
    project onto. Updating the *latest* entity rather than appending a new one
    is what makes this safe to call on every save.
    """
    if not content.strip():
        return None

    if stage == "specify":
        existing = repo.get_latest_requirement(project.id)
        title = markdown_title(content)
        requirement = (
            existing.model_copy(update={"title": title})
            if existing
            else Requirement(
                project_id=project.id,
                title=title,
                description=_summary(content),
                status=RequirementStatus.draft,
            )
        )
        repo.upsert_graph(project.id, GraphUpsertRequest(requirements=[requirement]), source="pz")
        return requirement.id

    if stage == "plan":
        requirement = repo.get_latest_requirement(project.id)
        if requirement is None:
            # A plan needs something to be a plan *for*. Rather than invent a
            # Requirement from the plan's own text, leave the graph alone —
            # the Planner locks `plan` until `specify` has a document, so this
            # is the out-of-order API caller, not the normal path.
            return None
        existing = repo.get_latest_spec_document(project.id)
        spec = (
            existing.model_copy(update={"content": content})
            if existing
            else SpecDocument(
                project_id=project.id,
                requirement_id=requirement.id,
                content=content,
                version=1,
            )
        )
        repo.upsert_graph(project.id, GraphUpsertRequest(spec_documents=[spec]), source="pz")
        return spec.id

    return None
