"""Plan 0029 delivery routes: the delivery plan (changes in dependency
waves), project hats, and approval decisions (M1 + M2).

Every table behind these routes is service-only (migration 0004); the rules
are here. Reads tolerate a database without migration 0004 (empty results);
writes answer 503 `delivery_store_unavailable`.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.api._guards import require_admin, require_project
from app.db.repository import DeliveryStoreUnavailable, Repository
from app.delivery.changes import wave_of
from app.delivery.decisions import STAGE_OF, ApprovalState, approval_state, content_hash
from app.dependencies import User, get_current_user, get_repository

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


def _current_hash(repo: Repository, project_id: str, stage: str) -> str | None:
    doc = repo.get_stage_document(project_id, stage)
    if doc is None or not doc.content.strip():
        return None
    return content_hash(doc.content)


def _decisions_state(repo: Repository, project_id: str) -> dict[str, ApprovalState]:
    decisions = repo.list_decisions(project_id)
    intent_hash = _current_hash(repo, project_id, STAGE_OF["intent_approval"])
    plan_hash = _current_hash(repo, project_id, STAGE_OF["plan_approval"])
    return {
        "intent": approval_state(decisions, "intent_approval", intent_hash),
        "plan": approval_state(decisions, "plan_approval", plan_hash),
    }


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
        plan_approval=_decisions_state(repo, project_id)["plan"],
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
