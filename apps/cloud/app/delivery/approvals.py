"""Approval reads over the repository (plan 0029 M2).

`decisions.py` holds the pure rules; this module applies them to a project:
the hash of a decision's subject (its stage documents) as it is now, the
approval state a project shows, and the mirror of that state onto the graph
entities that carry an approval field (`Requirement.status`,
`SpecDocument.status` and `approved_by`). The mirror is derived, never
authoritative — it is rewritten from the decisions whenever they or their
subject documents change, so an edit that makes an approval stale also takes
the "Approved" badge away.
"""

from __future__ import annotations

from collections.abc import Mapping

from app.db.repository import Repository
from app.delivery.decisions import (
    SUBJECT_STAGES,
    ApprovalState,
    approval_state,
    content_hash,
    latest_decision,
    subject_of,
)
from app.models.schemas import (
    Decision,
    GraphUpsertRequest,
    RequirementStatus,
    SpecStatus,
    StageDocument,
)


def document_hash(content: str | None) -> str | None:
    """The hash an approval binds for a subject's text; None for a missing or
    blank one, which there is nothing to approve in."""
    if content is None or not content.strip():
        return None
    return content_hash(content)


def _contents(docs: Mapping[str, StageDocument]) -> dict[str, str]:
    return {stage: doc.content for stage, doc in docs.items()}


def approval_subject(repo: Repository, project_id: str, kind: str) -> str | None:
    """What a decision of `kind` approves as the documents are now, in one
    read (`subject_of`); None when its last stage has no document."""
    docs = repo.list_stage_documents(project_id, SUBJECT_STAGES[kind])
    return subject_of(kind, _contents(docs))


def current_hash(repo: Repository, project_id: str, kind: str) -> str | None:
    return document_hash(approval_subject(repo, project_id, kind))


def subject_hashes(
    repo: Repository, project_id: str, known: dict[str, str | None] | None = None
) -> dict[str, str | None]:
    """The current hash of every decision kind's subject, keyed by kind.
    `known` carries hashes the caller already read in this request; the rest
    come from one repository read (each read is a database round trip)."""
    hashes = dict(known or {})
    missing = [kind for kind in SUBJECT_STAGES if kind not in hashes]
    if missing:
        stages = list(dict.fromkeys(s for kind in missing for s in SUBJECT_STAGES[kind]))
        contents = _contents(repo.list_stage_documents(project_id, stages))
        for kind in missing:
            hashes[kind] = document_hash(subject_of(kind, contents))
    return hashes


def states_of(
    decisions: list[Decision], hashes: dict[str, str | None]
) -> dict[str, ApprovalState]:
    """The approval states from decisions and subject hashes already in hand."""
    intent, plan = "intent_approval", "plan_approval"
    return {
        "intent": approval_state(decisions, intent, hashes[intent]),
        "plan": approval_state(decisions, plan, hashes[plan]),
    }


def plan_state(
    repo: Repository, project_id: str, contents: Mapping[str, str | None] | None = None
) -> ApprovalState:
    """The plan approval alone: reads only its own documents, and not even
    those when the caller passes what it already read: each stage's text, or
    None for a document that does not exist. Without every plan stage among
    `contents` the documents are read again rather than guessed missing."""
    kind = "plan_approval"
    if contents is None or any(stage not in contents for stage in SUBJECT_STAGES[kind]):
        plan_hash = current_hash(repo, project_id, kind)
    else:
        plan_hash = document_hash(subject_of(kind, contents))
    return approval_state(repo.list_decisions(project_id), kind, plan_hash)


def sync_approval_mirrors(
    repo: Repository,
    project_id: str,
    *,
    decisions: list[Decision] | None = None,
    hashes: dict[str, str | None] | None = None,
) -> None:
    """Write the current approval states onto the latest Requirement (intent)
    and SpecDocument (plan). Writes only a value that differs. A caller that
    already holds the project's decisions (as they stand after its write) and
    subject hashes passes them in instead of having them read again."""
    if decisions is None:
        decisions = repo.list_decisions(project_id)
    states = states_of(decisions, subject_hashes(repo, project_id, hashes))

    requirement = repo.get_latest_requirement(project_id)
    if requirement is not None:
        status = (
            RequirementStatus.approved if states["intent"] == "approved"
            else RequirementStatus.draft
        )
        if requirement.status != status:
            repo.upsert_graph(
                project_id,
                GraphUpsertRequest(
                    requirements=[requirement.model_copy(update={"status": status})]
                ),
                source="pz",
            )

    spec = repo.get_latest_spec_document(project_id)
    if spec is not None:
        if states["plan"] == "approved":
            latest = latest_decision(decisions, "plan_approval")
            update = {
                "status": SpecStatus.approved,
                "approved_by": latest.resolved_by if latest is not None else None,
            }
        else:
            update = {"status": SpecStatus.draft, "approved_by": None}
        if spec.status != update["status"] or spec.approved_by != update["approved_by"]:
            repo.upsert_graph(
                project_id,
                GraphUpsertRequest(spec_documents=[spec.model_copy(update=update)]),
                source="pz",
            )
