"""Shared authorization guards: workspace membership & admin role.

App-layer checks are the primary access control; when the backend forwards the
caller's JWT to Supabase, RLS enforces the same rules a second time.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.db.repository import Repository
from app.dependencies import User
from app.models.schemas import GraphUpsertRequest, Project, Role, TaskStatus, Workspace
from app.observability import tag_workspace

# Every authorised request passes through one of the three guards below, which
# makes them the single place a request's workspace is known for certain — so
# they are where an error report gets its `workspace_id` tag (plan 0021 M2).
# The tag is an id of ours, not a credential, and is what makes a report
# actionable; see app/observability.py for what is scrubbed instead.


def require_workspace(repo: Repository, workspace_id: str, user: User) -> Workspace:
    ws = repo.get_workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    if repo.get_membership(workspace_id, user.id) is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    tag_workspace(ws.id)
    return ws


def require_admin(repo: Repository, workspace_id: str, user: User) -> Workspace:
    ws = repo.get_workspace(workspace_id)
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace_not_found")
    if repo.get_membership(workspace_id, user.id) != Role.admin:
        raise HTTPException(status_code=403, detail="admin_required")
    tag_workspace(ws.id)
    return ws


# Spec Kit stages only a workspace admin may author. Both belong to the Tech
# Lead's step in the Planner: `plan` is the technical breakdown, and
# `constitution` is the standing rules seeded into the repository as AGENTS.md.
# Writing either (generate, prefill, save) is admin-only. Reading is never
# gated here: a business user can still open them, they just can't author them.
ADMIN_ONLY_STAGES = frozenset({"constitution", "plan"})


def require_stage_access(repo: Repository, project: Project, stage: str, user: User) -> None:
    """Authorization for *authoring* a stage, on top of project membership."""
    if stage in ADMIN_ONLY_STAGES:
        require_admin(repo, project.workspace_id, user)


# Which Spec Kit stage a graph entity type is the projection of — the inverse of
# app/generation/stage_apply.py's PROJECTION_NODE_TYPE, declared here rather than
# imported so the guards stay clear of the generation package (and its RAG
# queue). A push of one of these entities *is* an authoring of that stage, by a
# different door; keep the two maps in step.
GRAPH_ENTITY_STAGE: dict[str, str] = {
    "requirements": "specify",
    "spec_documents": "plan",
    "tasks": "tasks",
}


def _check_graph_write_permissions(
    repo: Repository, project: Project, user: User, payload: GraphUpsertRequest
) -> None:
    """The single-field routes' authorization, applied to a full-graph push.

    `PUT /sync/projects/{id}/graph` writes the same fields `set_task_status`,
    `assign_task` and the stage-authoring routes write, so plan 0015 closes the
    gap by making the weaker door refuse what the stronger ones refuse — and
    refuse it with the *identical* `detail`, which is what the cross-endpoint
    tests pin (a divergence then reads as a string mismatch, not a green test).
    This lives beside `require_stage_access` so a fourth route onto the graph
    imports the gate instead of re-deriving it.

    Membership is `require_project`'s job and is assumed done; this is the role
    layer on top of it. Every rule below restricts a non-admin only.
    """
    if repo.get_membership(project.workspace_id, user.id) == Role.admin:
        return

    # 1. Stage authoring. A `spec_documents` row is the `plan` stage's graph
    #    projection, so pushing one authors `plan` — which ADMIN_ONLY_STAGES
    #    reserves for the Tech Lead. Raises the same 403 admin_required the
    #    stage-document PATCH and the generation route raise.
    for entity_type, stage in GRAPH_ENTITY_STAGE.items():
        if stage in ADMIN_ONLY_STAGES and getattr(payload, entity_type):
            require_stage_access(repo, project, stage, user)

    for task in payload.tasks:
        stored = repo.get_task(project.id, task.id)

        # 2. Status, in `set_task_status`'s order: a member acts only on a task
        #    assigned to them, and `verified` is a review state no member may
        #    reach at all. Only an actual change is a write — a snapshot push
        #    that echoes the stored status must not be refused for it, and a task
        #    being created has no assignee to usurp.
        if stored is None or stored.status != task.status:
            if stored is not None and stored.assigned_user_id != user.id:
                raise HTTPException(status_code=403, detail="status_forbidden")
            if task.status == TaskStatus.verified:
                raise HTTPException(status_code=403, detail="verified_requires_admin")

        # 3. Assignment, in `assign_task`'s shape: self-assign or self-unassign
        #    only. `assigned_user_id` is written only when the caller set it
        #    explicitly (app/db/merge.py's _OMIT_IF_UNSET), so a push that never
        #    mentions the field is not an assignment and is not checked as one.
        if "assigned_user_id" not in task.model_fields_set:
            continue
        target = task.assigned_user_id
        current = stored.assigned_user_id if stored is not None else None
        if target == current:
            continue  # nothing changes
        self_assign = target is not None and target == user.id
        self_unassign = target is None and current == user.id
        if not (self_assign or self_unassign):
            raise HTTPException(status_code=403, detail="assignment_forbidden")


def require_project(repo: Repository, project_id: str, user: User) -> Project:
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project_not_found")
    if repo.get_membership(project.workspace_id, user.id) is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    tag_workspace(project.workspace_id)
    return project
