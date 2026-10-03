"""One write path for a stage's content, whichever way it arrived (plan 0018).

A Planner stage can change two ways: the model generates it
(app/api/generation.py) or a person edits the raw markdown and saves it
(app/api/stage_documents.py). Those two used to be different code with
different behaviour — generation minted brand-new graph rows on every run and
never retired the batch it replaced, while a manual save updated the existing
Requirement or SpecDocument in place and did nothing at all for `tasks`. The
`tasks` stage is where that divergence hurt: two generations of Task rows
carrying the same `T###` reference make every commit naming that reference
unattributable (app/integrations/task_refs.py::tasks_by_ref omits a colliding
ref rather than guessing), double-count in the web progress rollup, and keep
assignments and statuses alive on a cohort nobody is looking at.

So both routes call `apply_stage_content` and nothing else. It saves the raw
markdown, projects it onto the graph, enqueues whatever now needs re-embedding,
and reports back how far it got in one vocabulary (`StageApplyResult.projection`)
instead of each route implying success on its own terms.

Identity is stable **within a project**: an incoming checklist line is matched
to a live task by its normalized reference (`task_ref_from_feature_tag`), so
regenerating the same checklist updates the same rows — same ids, same
assignees, same statuses — rather than forking the board. A reference that was
live before and is absent now is *retired*, not deleted: `deleted_at` is set
through the same ordinary field write, which hides the row from bootstrap
pulls (`Repository.get_graph` with no `since`) and from future attribution
while leaving its status, assignee and every `Artifact` intact as history.

Out of scope, deliberately: app/api/sync.py's graph push and single-field task
writes. Those are the engine/editor merge path, not a stage document being
applied.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from app.db.merge import PLANNER_SEED_FIELDS
from app.db.repository import Repository
from app.generation.parsing import parse_task_lines
from app.integrations.task_refs import task_ref_from_feature_tag
from app.models.schemas import (
    AcceptanceCriterion,
    GraphUpsertRequest,
    Project,
    Requirement,
    RequirementStatus,
    SpecDocument,
    StageDocument,
    Task,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue

logger = logging.getLogger("promptworkspace.stage_apply")

# How faithfully the project graph reflects the stage document that was just
# saved. Both routes report this, so "the board didn't move" is something the
# Planner can say rather than something the user has to notice.
#
#   current        — the graph was updated from this content.
#   pending        — saved, projection not run yet (no path produces this today;
#                    reserved for a stage that grows an explicit apply step).
#   failed         — the document is saved but the graph was left untouched.
#   not_applicable — this stage has no graph entity to project onto.
ProjectionState = Literal["current", "pending", "failed", "not_applicable"]

# Stage -> the graph node_type it projects onto, stated exactly once so the
# enqueue side doesn't carry its own copy of the mapping. Stages absent from
# this dict (only `constitution`, which is project-level governance text with
# no entity of its own) project onto nothing.
PROJECTION_NODE_TYPE: dict[str, str] = {
    "specify": "requirements",
    "plan": "spec_documents",
    "tasks": "tasks",
}

_TITLE_FALLBACK = "Untitled specification"

NO_CHECKLIST_ERROR = "tasks document contained no parseable '- [ ] T###' checklist lines"

MISSING_REQUIREMENT_ERROR = "a plan needs a specification to be a plan for"

# Same detail code the generated path already raises as a 409 (app/api/
# generation.py) when `tasks` is requested with no plan yet. The manual-save
# route has no such gate today, so a `tasks` document saved out of order would
# otherwise create tasks with spec_id=None — invisible to ProgressRollup.tsx
# and skipped outright by the engine's incremental apply.
SPEC_DOCUMENT_REQUIRED_ERROR = "spec_document_required"


@dataclass(frozen=True)
class StageApplyResult:
    stage: str
    # The saved stage document. A save that fails raises instead of reporting —
    # the document is the one thing the caller cannot carry on without, so
    # there is no half-applied result to describe.
    document: StageDocument
    # Every graph entity this write touched, retired tasks included.
    entity_ids: list[str] = field(default_factory=list)
    projection: ProjectionState = "not_applicable"
    # Live tasks the checklist now describes (`tasks` stage only).
    task_count: int | None = None
    # Tasks this write tombstoned — dropped from the checklist, or a
    # pre-existing duplicate reference this write consolidated (`tasks` stage
    # only). A save can retire tasks silently otherwise: the assignee and
    # status on a retired row are gone from view even though `projection` says
    # "current", so callers should surface this count, not just task_count.
    retired_count: int | None = None
    # Why `projection` is "failed", in the caller's own error vocabulary.
    error: str | None = None

    @property
    def document_id(self) -> str:
        return self.document.id

    @property
    def document_updated_at(self) -> str | None:
        if self.document.updated_at is None:
            return None
        return self.document.updated_at.isoformat()


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


def apply_stage_content(
    repo: Repository,
    project: Project,
    stage: str,
    content: str,
    *,
    source: Literal["generated", "manual"],
    actor_id: str,
    app: Any = None,
    user_input: str | None = None,
) -> StageApplyResult:
    """Save a stage's markdown and project it onto the project graph.

    `source` says which route this came from — generated content carries the
    author's prompt in `user_input`, which is what a Requirement's description
    is written from and what titles a document with no H1; a manual edit has
    neither and falls back to the document's own text. `app` is the FastAPI
    application the RAG embed queue lives on; omitted (as in a unit test that
    has no app) nothing is enqueued.

    A failing projection never costs the user their text: the document is
    saved first, and anything the graph rejects comes back as
    `projection="failed"` with `error` set rather than as an exception.
    """
    document = repo.upsert_stage_document(
        project.id, project.workspace_id, stage, content, actor_id
    )
    _enqueue(app, project, "stage_documents", document.id)

    try:
        projection, entity_ids, task_count, retired_count, error = _project(
            repo, project, stage, content, user_input=user_input
        )
    except Exception:
        # The document is already saved. A failed projection costs the next
        # stage its unlock, not the user's work, so it is reported rather
        # than raised — and reported honestly, which is the whole point of
        # `projection` existing.
        logger.exception(
            "graph projection failed for project=%s stage=%s source=%s",
            project.id,
            stage,
            source,
        )
        return StageApplyResult(
            stage=stage, document=document, projection="failed", error="graph_write_failed"
        )

    node_type = PROJECTION_NODE_TYPE.get(stage)
    if node_type is not None:
        # The stage document above is one EmbedJob; each graph entity it was
        # projected onto is another. upsert_graph's other caller
        # (app/api/sync.py) enqueues for a push, but this path writes to the
        # repository directly, so the jobs are raised here — in one place,
        # rather than in each route that happens to remember.
        for entity_id in entity_ids:
            _enqueue(app, project, node_type, entity_id)

    return StageApplyResult(
        stage=stage,
        document=document,
        entity_ids=entity_ids,
        projection=projection,
        task_count=task_count,
        retired_count=retired_count,
        error=error,
    )


def _project(
    repo: Repository,
    project: Project,
    stage: str,
    content: str,
    *,
    user_input: str | None,
) -> tuple[ProjectionState, list[str], int | None, int | None, str | None]:
    if stage not in PROJECTION_NODE_TYPE or not content.strip():
        # `constitution` has no entity, and clearing the editor is not a
        # request to create a titleless Requirement or to empty the board.
        return "not_applicable", [], None, None, None

    if stage == "specify":
        return "current", [_apply_specify(repo, project, content, user_input)], None, None, None

    if stage == "plan":
        requirement = repo.get_latest_requirement(project.id)
        if requirement is None:
            # Rather than invent a Requirement from the plan's own text, leave
            # the graph alone and say so. The Planner locks `plan` until
            # `specify` has a document, so this is the out-of-order API
            # caller, not the normal path.
            return "failed", [], None, None, MISSING_REQUIREMENT_ERROR
        return (
            "current",
            [_apply_plan(repo, project, requirement, content)],
            None,
            None,
            None,
        )

    # `tasks` needs a plan to hang its spec_id on (app/api/generation.py raises
    # the same 409 for the generated path) — without this gate a manual save
    # ahead of `plan` would create tasks ProgressRollup.tsx and the engine's
    # incremental apply both silently skip, since they filter/drop a task with
    # no spec_id.
    if repo.get_latest_spec_document(project.id) is None:
        return "failed", [], None, None, SPEC_DOCUMENT_REQUIRED_ERROR

    parsed = parse_task_lines(content)
    if not parsed:
        return "failed", [], None, None, NO_CHECKLIST_ERROR
    written, live_count, retired_count = _apply_tasks(repo, project, parsed)
    return "current", written, live_count, retired_count, None


def _apply_specify(
    repo: Repository, project: Project, content: str, user_input: str | None
) -> str:
    existing = repo.get_latest_requirement(project.id)
    title = markdown_title(content, fallback=(user_input or "")[:80] or _TITLE_FALLBACK)
    if existing is not None:
        update: dict[str, object] = {"title": title}
        if user_input is not None:
            # A regeneration's prompt is the requirement's new description; a
            # hand edit has no prompt, so the description it was created with
            # stands.
            update["description"] = user_input
        requirement = existing.model_copy(update=update)
    else:
        requirement = Requirement(
            project_id=project.id,
            title=title,
            description=user_input if user_input is not None else _summary(content),
            status=RequirementStatus.draft,
        )
    repo.upsert_graph(project.id, GraphUpsertRequest(requirements=[requirement]), source="pz")
    return requirement.id


def _apply_plan(
    repo: Repository, project: Project, requirement: Requirement, content: str
) -> str:
    existing = repo.get_latest_spec_document(project.id)
    spec = (
        existing.model_copy(update={"content": content})
        if existing is not None
        else SpecDocument(
            project_id=project.id,
            requirement_id=requirement.id,
            content=content,
            version=1,
        )
    )
    repo.upsert_graph(project.id, GraphUpsertRequest(spec_documents=[spec]), source="pz")
    return spec.id


def _apply_tasks(
    repo: Repository, project: Project, parsed: list[dict[str, object]]
) -> tuple[list[str], int, int]:
    """Reconcile the checklist against the board: update, insert, retire.

    Matching is by normalized reference, so "T012" in one generation and "T12"
    in the next are the same task — which is exactly why a textual comparison
    of `feature_tag` could never do this job. `parse_task_lines` only ever
    emits `T\\d+` refs, which `task_ref_from_feature_tag` always normalizes, so
    every ref handled below is a real string, never `None`.
    """
    spec = repo.get_latest_spec_document(project.id)
    spec_id = spec.id if spec is not None else None

    # A bootstrap pull (no `since`) is the live board: tombstoned rows are
    # already excluded by the repository, so a retired task is never revived
    # by a later regeneration that happens to reuse its reference.
    live: dict[str, Task] = {}
    # A reference more than one live row already claims is a pre-existing
    # collision (written before this path existed, or by a concurrent write
    # this reconciliation didn't see). The checklist can only ever update one
    # row per reference, so every row past the first is retired unconditionally
    # below — otherwise the collision survives every regeneration forever,
    # which is the exact bug this module exists to fix.
    duplicate_live: list[Task] = []
    for task in repo.get_graph(project.id).tasks:
        ref = task_ref_from_feature_tag(task.feature_tag)
        if ref is None:
            continue
        if ref in live:
            duplicate_live.append(task)
        else:
            live[ref] = task

    writes: list[Task] = []
    claimed: set[str] = set()
    for row in parsed:
        raw_ref = str(row["ref"])
        ref = task_ref_from_feature_tag(raw_ref)
        if ref in claimed:
            # Two checklist lines claiming one reference is one task written
            # twice, and landing both is precisely the collision this module
            # exists to prevent.
            logger.warning(
                "tasks checklist repeats reference %s for project=%s — keeping the first line",
                ref,
                project.id,
            )
            continue
        title = str(row["title"])
        tag = f"{raw_ref} [P]" if row["parallel"] else raw_ref
        fields = {
            "title": title,
            "acceptance_criteria": [AcceptanceCriterion(text=title)],
            "feature_tag": tag,
            "spec_id": spec_id,
        }
        existing = live.get(ref)
        if existing is not None:
            # Same id, same assignee, same status — only the content moves.
            writes.append(existing.model_copy(update=fields))
        else:
            writes.append(Task(project_id=project.id, **fields))
        claimed.add(ref)

    live_count = len(writes)
    retired_at = utcnow()
    for ref, task in live.items():
        if ref in claimed:
            continue
        writes.append(task.model_copy(update={"deleted_at": retired_at}))
    for task in duplicate_live:
        # Consolidated into whichever row above now carries this reference
        # (or itself retired, if the checklist dropped the reference too) —
        # either way, a reference keeps at most one live row after this write.
        writes.append(task.model_copy(update={"deleted_at": retired_at}))

    retired_count = len(writes) - live_count
    # The Planner is the writer that puts the plan's reference into `feature_tag`
    # at creation, and the only one: the field's declared owner is the tracker,
    # so the creation gate lets it through only for a caller that names it
    # (app/db/merge.py). A graph push cannot, which is what stops a member
    # forging a reference and capturing another task's commit attribution.
    repo.upsert_graph(
        project.id,
        GraphUpsertRequest(tasks=writes),
        source="pz",
        seed_fields=PLANNER_SEED_FIELDS,
    )
    return [task.id for task in writes], live_count, retired_count


def _enqueue(app: Any, project: Project, node_type: str, node_id: str) -> None:
    if app is None:
        return
    enqueue(app, EmbedJob(project.workspace_id, project.id, node_type, node_id))
