"""Plan 0029 delivery routes: the delivery plan (changes in dependency
waves), project hats, and approval decisions (M1 + M2).

Every table behind these routes is service-only (migration 0004); the rules
are here. Reads tolerate a database without migration 0004 (empty results);
writes answer 503 `delivery_store_unavailable`.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.api._guards import require_admin, require_project
from app.db.repository import DeliveryStoreUnavailable, Repository
from app.delivery.approvals import current_hash, decisions_state, sync_approval_mirrors
from app.delivery.changes import wave_of
from app.delivery.decisions import (
    HAT_OF,
    STAGE_OF,
    TITLE_OF,
    ApprovalState,
    can_resolve,
    latest_decision,
)
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import Decision, Role, utcnow

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
    for task in repo.get_graph(project_id).tasks:
        if task.change_id in task_ids:
            task_ids[task.change_id].append(task.id)
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
        plan_approval=decisions_state(repo, project_id)["plan"],
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


class DecisionOut(BaseModel):
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


class DecisionsOut(BaseModel):
    decisions: list[DecisionOut]
    states: dict[str, ApprovalState]


class DecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: DecisionKindIn


class DecisionResolve(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["approved", "rejected"]
    rationale: str | None = None


def decision_out(
    decision: Decision,
    *,
    user_id: str,
    roles,
    member_ids: set[str],
    is_admin: bool,
) -> DecisionOut:
    return DecisionOut(
        **decision.model_dump(),
        can_resolve=can_resolve(decision, user_id, roles, member_ids, is_admin),
    )


def _routing_context(repo: Repository, project, user: User):
    roles = repo.list_project_roles(project.id)
    member_ids = {m.user_id for m in repo.list_members(project.workspace_id)}
    is_admin = repo.get_membership(project.workspace_id, user.id) == Role.admin
    return roles, member_ids, is_admin


@router.get("/projects/{project_id}/decisions", response_model=DecisionsOut)
def list_project_decisions(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionsOut:
    project = require_project(repo, project_id, user)
    roles, member_ids, is_admin = _routing_context(repo, project, user)
    return DecisionsOut(
        decisions=[
            decision_out(d, user_id=user.id, roles=roles, member_ids=member_ids,
                         is_admin=is_admin)
            for d in repo.list_decisions(project_id)
        ],
        states=decisions_state(repo, project_id),
    )


@router.post("/projects/{project_id}/decisions", response_model=DecisionOut)
def request_decision(
    project_id: str,
    body: DecisionRequest,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionOut:
    project = require_project(repo, project_id, user)
    stage = STAGE_OF[body.kind]
    current = current_hash(repo, project_id, stage)
    if current is None:
        raise HTTPException(status_code=409, detail="decision_subject_missing")
    if body.kind == "plan_approval" and not repo.list_delivery_changes(project_id):
        raise HTTPException(status_code=409, detail="delivery_plan_missing")
    roles, member_ids, is_admin = _routing_context(repo, project, user)

    try:
        decisions = repo.list_decisions(project_id)
        latest = latest_decision(decisions, body.kind)
        if latest is not None and latest.status == "approved" and latest.subject_hash == current:
            # Already approved as it stands: asking again must not demote it
            # to pending (which would also close the create-repository gate).
            return decision_out(latest, user_id=user.id, roles=roles,
                                member_ids=member_ids, is_admin=is_admin)
        for existing in decisions:
            if existing.kind != body.kind or existing.status != "open":
                continue
            if existing.subject_hash == current:
                return decision_out(existing, user_id=user.id, roles=roles,
                                    member_ids=member_ids, is_admin=is_admin)
            repo.save_decision(existing.model_copy(update={"status": "withdrawn"}))
        decision = repo.save_decision(
            Decision(
                project_id=project_id,
                workspace_id=project.workspace_id,
                kind=body.kind,
                title=TITLE_OF[body.kind],
                subject_stage=stage,
                subject_hash=current,
                routed_hat=HAT_OF[body.kind],
                requested_by=user.id,
            )
        )
    except DeliveryStoreUnavailable:
        raise HTTPException(status_code=503, detail="delivery_store_unavailable") from None
    return decision_out(decision, user_id=user.id, roles=roles, member_ids=member_ids,
                        is_admin=is_admin)


@router.post(
    "/projects/{project_id}/decisions/{decision_id}/resolve", response_model=DecisionOut
)
def resolve_decision(
    project_id: str,
    decision_id: str,
    body: DecisionResolve,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DecisionOut:
    project = require_project(repo, project_id, user)
    decision = repo.get_decision(project_id, decision_id)
    if decision is None:
        raise HTTPException(status_code=404, detail="decision_not_found")
    if decision.status != "open":
        raise HTTPException(status_code=409, detail="decision_not_open")
    roles, member_ids, is_admin = _routing_context(repo, project, user)
    if not can_resolve(decision, user.id, roles, member_ids, is_admin):
        raise HTTPException(status_code=403, detail="decision_not_routed_to_you")
    if current_hash(repo, project_id, decision.subject_stage) != decision.subject_hash:
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
    try:
        sync_approval_mirrors(repo, project_id)
    except Exception:
        # The decision is saved; the mirror is derived and rewritten on the
        # next resolve or stage save, so a failed write must not turn a
        # committed approval into a 500.
        logger.exception("approval mirror sync failed for project=%s", project_id)
    return decision_out(resolved, user_id=user.id, roles=roles, member_ids=member_ids,
                        is_admin=is_admin)
