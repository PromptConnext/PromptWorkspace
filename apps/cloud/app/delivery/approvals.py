"""Approval reads over the repository (plan 0029 M2).

`decisions.py` holds the pure rules; this module applies them to a project:
the hash of a decision's subject document as it is now, the approval state a
project shows, and the mirror of that state onto the graph entities that
carry an approval field (`Requirement.status`, `SpecDocument.status` and
`approved_by`). The mirror is derived, never authoritative — it is rewritten
from the decisions whenever they or their subject documents change, so an
edit that makes an approval stale also takes the "Approved" badge away.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.delivery.decisions import (
    STAGE_OF,
    ApprovalState,
    approval_state,
    content_hash,
    latest_decision,
)
from app.models.schemas import Decision, GraphUpsertRequest, RequirementStatus, SpecStatus


def current_hash(repo: Repository, project_id: str, stage: str) -> str | None:
    doc = repo.get_stage_document(project_id, stage)
    if doc is None or not doc.content.strip():
        return None
    return content_hash(doc.content)


def decisions_state(repo: Repository, project_id: str) -> dict[str, ApprovalState]:
    return _states(repo, project_id, repo.list_decisions(project_id))


def _states(
    repo: Repository, project_id: str, decisions: list[Decision]
) -> dict[str, ApprovalState]:
    intent_hash = current_hash(repo, project_id, STAGE_OF["intent_approval"])
    plan_hash = current_hash(repo, project_id, STAGE_OF["plan_approval"])
    return {
        "intent": approval_state(decisions, "intent_approval", intent_hash),
        "plan": approval_state(decisions, "plan_approval", plan_hash),
    }


def sync_approval_mirrors(repo: Repository, project_id: str) -> None:
    """Write the current approval states onto the latest Requirement (intent)
    and SpecDocument (plan). Writes only a value that differs."""
    decisions = repo.list_decisions(project_id)
    states = _states(repo, project_id, decisions)

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
