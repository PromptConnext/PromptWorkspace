"""Plan 0029 delivery routes: the delivery plan (changes in dependency
waves), project hats, and approval decisions (M1 + M2).

Every table behind these routes is service-only (migration 0004); the rules
are here. Reads tolerate a database without migration 0004 (empty results);
writes answer 503 `delivery_store_unavailable`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from functools import partial
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.api._guards import require_admin, require_project, require_project_members
from app.db.repository import DeliveryStoreUnavailable, Repository
from app.delivery.approvals import (
    current_hash,
    decisions_state,
    plan_state,
    stage_hashes,
    states_of,
    sync_approval_mirrors,
)
from app.delivery.changes import wave_of
from app.delivery.decisions import (
    HAT_OF,
    STAGE_OF,
    TITLE_OF,
    ApprovalState,
    can_resolve,
    content_hash,
    latest_decision,
)
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import Decision, Project, Role, WorkspaceMember, utcnow

logger = logging.getLogger("promptworkspace.delivery")

router = APIRouter(tags=["delivery"])

Hat = Literal["business_owner", "tech_steward"]
HATS: tuple[Hat, ...] = ("business_owner", "tech_steward")


class DeliveryChangeOut(BaseModel):
    id: str
    ref: str
    key: str
    title: str
    kind: str
    story: int | None
    priority: str | None
    position: int
    wave: int
    depends_on: list[str]
    task_ids: list[str]


class DeliveryPlanOut(BaseModel):
    changes: list[DeliveryChangeOut]
    plan_approval: ApprovalState


class ProjectRoleOut(BaseModel):
    hat: Hat
    user_id: str | None


class ProjectRoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str | None


@router.get("/projects/{project_id}/delivery-plan", response_model=DeliveryPlanOut)
def get_delivery_plan(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DeliveryPlanOut:
    require_project(repo, project_id, user)
    changes = repo.list_delivery_changes(project_id)
    waves = wave_of(changes)
    ref_of_key = {c.key: c.ref for c in changes}
    task_ids: dict[str, list[str]] = {c.id: [] for c in changes}
    for task_id, change_id in repo.list_task_change_ids(project_id):
        if change_id in task_ids:
            task_ids[change_id].append(task_id)
    return DeliveryPlanOut(
        changes=[
            DeliveryChangeOut(
                id=c.id,
                ref=c.ref,
                key=c.key,
                title=c.title,
                kind=c.kind,
                story=c.story,
                priority=c.priority,
                position=c.position,
                wave=waves[c.key],
                depends_on=[ref_of_key[k] for k in c.depends_on if k in ref_of_key],
                task_ids=task_ids[c.id],
            )
            for c in changes
        ],
        plan_approval=plan_state(repo, project_id),
    )


def _roles_out(repo: Repository, project_id: str) -> list[ProjectRoleOut]:
    holders = {r.hat: r.user_id for r in repo.list_project_roles(project_id)}
    return [ProjectRoleOut(hat=hat, user_id=holders.get(hat)) for hat in HATS]


@router.get("/projects/{project_id}/roles", response_model=list[ProjectRoleOut])
def get_project_roles(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[ProjectRoleOut]:
    require_project(repo, project_id, user)
    return _roles_out(repo, project_id)


@router.put("/projects/{project_id}/roles/{hat}", response_model=list[ProjectRoleOut])
def put_project_role(
    project_id: str,
    hat: Hat,
    body: ProjectRoleUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[ProjectRoleOut]:
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    if body.user_id is not None and repo.get_membership(project.workspace_id, body.user_id) is None:
        raise HTTPException(status_code=400, detail="role_user_not_a_member")
    try:
        repo.set_project_role(project_id, project.workspace_id, hat, body.user_id, user.id)
    except DeliveryStoreUnavailable:
        raise HTTPException(status_code=503, detail="delivery_store_unavailable") from None
    return _roles_out(repo, project_id)


DecisionKindIn = Literal["intent_approval", "plan_approval"]


class DecisionBase(BaseModel):
    """A decision's fields without the two that are costly: the document text
    (`DecisionOut.subject_content`) and the staleness check (`is_current`)."""

    id: str
    project_id: str
    workspace_id: str
    kind: str
    title: str
    subject_stage: str
    subject_hash: str
    routed_hat: str
    status: str
    rationale: str | None
    requested_by: str
    resolved_by: str | None
    created_at: datetime
    resolved_at: datetime | None
    can_resolve: bool


class DecisionOut(DecisionBase):
    # The document text at request time; null for a decision made before
    # migration 0006 and for older decisions a listing leaves out
    # (`content_carriers`).
    subject_content: str | None
    # True while `subject_hash` is the hash of the stage document as it is now;
    # false once the document was edited after this decision was made.
    is_current: bool


class DecisionsOut(BaseModel):
    decisions: list[DecisionOut]
    states: dict[str, ApprovalState]


class DecisionMutationOut(DecisionOut):
    """The requested or resolved decision, plus `snapshot`: the project's
    `GET /decisions` as it stands after the write, so a client applies it
    instead of refetching. `None` when the stage documents could not be read
    after the write; the client refetches then."""

    snapshot: DecisionsOut | None = None


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: DecisionKindIn


class DecisionResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["approved", "rejected"]
    rationale: str | None = None


def content_carriers(decisions: list[Decision]) -> set[str]:
    """The ids of the decisions a listing sends `subject_content` for: the open
    ones (the approver reads and diffs them) and the newest approved decision of
    each kind (the diff base for the next request). Every older decision would
    cost its whole document, up to ~12 KB each, on every tab load."""
    keep = {d.id for d in decisions if d.status == "open"}
    newest: dict[str, Decision] = {}
    for d in decisions:
        if d.status == "approved" and (
            d.kind not in newest or d.created_at > newest[d.kind].created_at
        ):
            newest[d.kind] = d
    return keep | {d.id for d in newest.values()}


def decision_out(
    decision: Decision,
    *,
    user_id: str,
    roles,
    member_ids: set[str],
    is_admin: bool,
    hashes: dict[str, str | None] | None = None,
    with_content: bool = True,
) -> DecisionOut:
    """`hashes` are the stage hashes as they are now. Without them (the read
    after a write failed) a decision reads as current: the request and resolve
    routes only write against a document whose hash they just matched.
    `with_content=False` leaves `subject_content` out (see `content_carriers`)."""
    return DecisionOut(
        **decision.model_dump(exclude={"subject_content"}),
        subject_content=decision.subject_content if with_content else None,
        can_resolve=can_resolve(decision, user_id, roles, member_ids, is_admin),
        is_current=hashes is None or hashes.get(decision.subject_stage) == decision.subject_hash,
    )


def _routing_context(
    repo: Repository, project: Project, role: Role, members: list[WorkspaceMember]
):
    """Who may resolve what, from the caller's `role` and the workspace
    `members` that `require_project_members` already read."""
    roles = repo.list_project_roles(project.id)
    return roles, {m.user_id for m in members}, role == Role.admin


def _hashes_after_write(repo: Repository, project_id: str) -> dict[str, str | None] | None:
    """The stage hashes read after this request's write, so the mirror and the
    snapshot describe the documents as they are now, including an edit that
    landed while the request ran. `None` when the read fails: the write is
    committed and must not become a 500, so the caller skips the mirror (it
    is rewritten on the next resolve or stage save) and sends no snapshot.
    Not exact under concurrency: a stage save landing between this read and
    the mirror write can still be overwritten by a mirror computed from these
    hashes, until that next resolve or stage save corrects it."""
    try:
        return stage_hashes(repo, project_id)
    except Exception:
        logger.exception("stage hash read failed after a decision write, project=%s",
                         project_id)
        return None


def _mutation_out(
    decision: Decision,
    decisions: list[Decision],
    hashes: dict[str, str | None] | None,
    out: Callable[..., DecisionOut],
) -> DecisionMutationOut:
    """`decision` with the listing after the write: `decisions` are the
    project's decisions as they now stand (newest first), `hashes` the stage
    hashes read after it (no snapshot without them)."""
    snapshot = None
    if hashes is not None:
        keep = content_carriers(decisions)
        snapshot = DecisionsOut(
            decisions=[out(d, hashes=hashes, with_content=d.id in keep) for d in decisions],
            states=states_of(decisions, hashes),
        )
    return DecisionMutationOut(**out(decision, hashes=hashes).model_dump(), snapshot=snapshot)


@router.get("/projects/{project_id}/decisions", response_model=DecisionsOut)
def list_project_decisions(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionsOut:
    project, role, members = require_project_members(repo, project_id, user)
    roles, member_ids, is_admin = _routing_context(repo, project, role, members)
    decisions = repo.list_decisions(project_id)
    hashes = stage_hashes(repo, project_id)
    keep = content_carriers(decisions)
    return DecisionsOut(
        decisions=[
            decision_out(d, user_id=user.id, roles=roles, member_ids=member_ids,
                         is_admin=is_admin, hashes=hashes, with_content=d.id in keep)
            for d in decisions
        ],
        states=decisions_state(repo, project_id, decisions, hashes),
    )


@router.post("/projects/{project_id}/decisions", response_model=DecisionMutationOut)
def request_decision(
    project_id: str,
    body: DecisionRequest,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionMutationOut:
    project, role, members = require_project_members(repo, project_id, user)
    stage = STAGE_OF[body.kind]
    # One read gives the hash and the text it covers, so the stored snapshot
    # is exactly the document the hash binds.
    document = repo.get_stage_document(project_id, stage)
    if document is None or not document.content.strip():
        raise HTTPException(status_code=409, detail="decision_subject_missing")
    current = content_hash(document.content)
    if body.kind == "plan_approval" and not repo.list_delivery_changes(project_id):
        raise HTTPException(status_code=409, detail="delivery_plan_missing")
    roles, member_ids, is_admin = _routing_context(repo, project, role, members)
    out = partial(decision_out, user_id=user.id, roles=roles, member_ids=member_ids,
                  is_admin=is_admin)

    try:
        decisions = repo.list_decisions(project_id)
        latest = latest_decision(decisions, body.kind)
        if latest is not None and latest.status == "approved" and latest.subject_hash == current:
            # Already approved as it stands: asking again must not demote it
            # to pending (which would also close the create-repository gate).
            return _mutation_out(latest, decisions, _hashes_after_write(repo, project_id), out)
        after = list(decisions)  # the listing as this request leaves it
        for i, existing in enumerate(decisions):
            if existing.kind != body.kind or existing.status != "open":
                continue
            if existing.subject_hash == current:
                return _mutation_out(existing, after, _hashes_after_write(repo, project_id), out)
            after[i] = repo.save_decision(existing.model_copy(update={"status": "withdrawn"}))
        decision = repo.save_decision(
            Decision(
                project_id=project_id,
                workspace_id=project.workspace_id,
                kind=body.kind,
                title=TITLE_OF[body.kind],
                subject_stage=stage,
                subject_hash=current,
                subject_content=document.content,
                routed_hat=HAT_OF[body.kind],
                requested_by=user.id,
            )
        )
    except DeliveryStoreUnavailable:
        raise HTTPException(status_code=503, detail="delivery_store_unavailable") from None
    return _mutation_out(decision, [decision, *after], _hashes_after_write(repo, project_id), out)


@router.post(
    "/projects/{project_id}/decisions/{decision_id}/resolve",
    response_model=DecisionMutationOut,
)
def resolve_decision(
    project_id: str,
    decision_id: str,
    body: DecisionResolve,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionMutationOut:
    project, role, members = require_project_members(repo, project_id, user)
    # The whole list, not `get_decision`: the same one request, and the
    # approval states, the mirror and the snapshot all need it afterwards.
    decisions = repo.list_decisions(project_id)
    decision = next((d for d in decisions if d.id == decision_id), None)
    if decision is None:
        raise HTTPException(status_code=404, detail="decision_not_found")
    if decision.status != "open":
        raise HTTPException(status_code=409, detail="decision_not_open")
    roles, member_ids, is_admin = _routing_context(repo, project, role, members)
    if not can_resolve(decision, user.id, roles, member_ids, is_admin):
        raise HTTPException(status_code=403, detail="decision_not_routed_to_you")
    current = current_hash(repo, project_id, decision.subject_stage)
    if current != decision.subject_hash:
        raise HTTPException(status_code=409, detail="decision_subject_changed")
    rationale = (body.rationale or "").strip() or None
    if body.outcome == "rejected" and rationale is None:
        raise HTTPException(status_code=422, detail="rationale_required")
    resolved = decision.model_copy(
        update={
            "status": body.outcome,
            "rationale": rationale,
            "resolved_by": user.id,
            "resolved_at": utcnow(),
        }
    )
    try:
        repo.save_decision(resolved)
    except DeliveryStoreUnavailable:
        raise HTTPException(status_code=503, detail="delivery_store_unavailable") from None
    after = [resolved if d.id == resolved.id else d for d in decisions]
    hashes = _hashes_after_write(repo, project_id)
    if hashes is not None:
        try:
            sync_approval_mirrors(repo, project_id, decisions=after, hashes=hashes)
        except Exception:
            # The decision is saved; the mirror is derived and rewritten on the
            # next resolve or stage save, so a failed write must not turn a
            # committed approval into a 500.
            logger.exception("approval mirror sync failed for project=%s", project_id)
    out = partial(decision_out, user_id=user.id, roles=roles, member_ids=member_ids,
                  is_admin=is_admin)
    return _mutation_out(resolved, after, hashes, out)
