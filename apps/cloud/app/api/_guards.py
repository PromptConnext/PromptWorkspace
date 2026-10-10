"""Shared authorization guards: workspace membership & admin role.

These checks are the only enforcement of admin-only stage authoring, task
ownership, admin-only verification, and comment attribution
(docs/plans/0014-row-level-security-parity.md). Postgres RLS on the graph
tables was previously assumed to re-check the same rules; it never did —
every policy there tested workspace membership and nothing else — and as of
migration 0031 the `authenticated` role has no grant on those seven tables at
all, so RLS does not run for them either. This module is not "primary" among
layers that also enforce these rules. It is the entire enforcement.

Outside that set, `app/db/supabase_repository.py::for_user` still scopes
calls to the caller's JWT, and RLS still enforces workspace membership. The
policies and these guards agree fully on only two tables: pw_workspaces
(`pw_ws_write`) and pw_workspace_members (`pw_members_write`), whose policies
genuinely test `pw_is_admin`.

Two known divergences remain, both outside plan 0014's scope and neither
closed here:
  * pw_projects — `pw_projects_rw` is membership-only, while the writes that
    matter are admin-gated in the API alone (deployment_config and
    policy_scope via app/api/deployments.py's require_admin, lifecycle_status
    via app/api/sync.py). A member reaching PostgREST directly can still set
    those fields.
  * pw_discussions — closed as of migration 0031, which added it to the
    service-only set; named here because plan 0014's own matrix omitted it
    and a reader comparing the two will look for it.
"""

from __future__ import annotations

from fastapi import HTTPException

from app.db.repository import Repository
from app.dependencies import User
from app.models.schemas import (
    GraphUpsertRequest,
    Project,
    Role,
    TaskStatus,
    Workspace,
    WorkspaceMember,
)
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
    layer on top of it. Only the assignee-membership rule applies to admins; the
    rest are non-admin restrictions.

    A field the writer never set is not a write at all (app/db/merge.py's
    `_NEVER_IMPLICIT`), so every rule below reads `model_fields_set` rather than
    the dump — otherwise an ordinary snapshot push, which carries every field at
    its default, would be refused for fields it never meant to touch.
    """
    # Applies to everyone: `assign_task` refuses a target who is not a member of
    # the task's workspace (400 assignee_not_a_member), and an admin going
    # through the graph door must not be able to park a task on a non-member.
    targets = {
        task.assigned_user_id
        for task in payload.tasks
        if "assigned_user_id" in task.model_fields_set and task.assigned_user_id is not None
    }
    if targets and not targets <= {m.user_id for m in repo.list_members(project.workspace_id)}:
        raise HTTPException(status_code=400, detail="assignee_not_a_member")

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
        fields_set = task.model_fields_set
        owns_it = stored is not None and stored.assigned_user_id == user.id

        # 2. Status, in `set_task_status`'s order: a member acts only on a task
        #    assigned to them, and `verified` is a review state no member may
        #    reach at all. Only an actual change is a write — a snapshot push
        #    that echoes the stored status must not be refused for it, and a task
        #    being created has no assignee to usurp.
        if "status" in fields_set and (stored is None or stored.status != task.status):
            if stored is not None and not owns_it:
                raise HTTPException(status_code=403, detail="status_forbidden")
            if task.status == TaskStatus.verified:
                raise HTTPException(status_code=403, detail="verified_requires_admin")

        # 3. Tombstones. A graph push is the *only* delete door in the system, so
        #    there is no dedicated route to mirror — but retiring somebody's task
        #    is at least as destructive as closing it, and gets the same rule.
        if "deleted_at" in fields_set and (stored is None or stored.deleted_at != task.deleted_at):
            if stored is not None and not owns_it:
                raise HTTPException(status_code=403, detail="delete_forbidden")

        # 4. Assignment, in `assign_task`'s shape: self-assign or self-unassign
        #    only.
        if "assigned_user_id" not in fields_set:
            continue
        target = task.assigned_user_id
        current = stored.assigned_user_id if stored is not None else None
        if target == current:
            continue  # nothing changes
        self_assign = target is not None and target == user.id
        self_unassign = target is None and current == user.id
        if not (self_assign or self_unassign):
            raise HTTPException(status_code=403, detail="assignment_forbidden")

    # 5. Evidence. An Artifact says "this commit closed this task" and an AgentRun
    #    says "this model did this work on it" — both are the closure record ADR
    #    0022 and ADR 0023 read. `set_task_status` writes an Artifact only under
    #    the status rule above (its `body.artifact`), so the graph door applies
    #    that same rule, with the same detail, to the task each one points at.
    #    Evidence for a task created in this very push is allowed: nobody else
    #    owns it yet. Evidence for a task that exists nowhere is not — a dangling
    #    artifact is either a mistake or a forgery.
    created_here = {task.id for task in payload.tasks}
    for entity_type in ("artifacts", "agent_runs"):
        for item in getattr(payload, entity_type):
            target_task = repo.get_task(project.id, item.task_id)
            if target_task is None:
                if item.task_id in created_here:
                    continue
                raise HTTPException(status_code=403, detail="status_forbidden")
            if target_task.assigned_user_id != user.id:
                raise HTTPException(status_code=403, detail="status_forbidden")

    # 6. Comments. `create_discussion` never takes `author` from the client and
    #    always writes source="pz" (its module docstring says so in as many
    #    words), because a comment is an attributed statement. The graph door
    #    took both from the body, so a member could post as somebody else — and,
    #    since `body`/`author` are "shared" authority, could overwrite an
    #    existing comment's text and reassign its authorship to themselves.
    for discussion in payload.discussions:
        if discussion.author != user.id or discussion.source != "pz":
            raise HTTPException(status_code=403, detail="discussion_author_forbidden")
        stored_discussion = repo.get_node(project.id, "discussions", discussion.id)
        if stored_discussion is not None and stored_discussion.author != user.id:
            raise HTTPException(status_code=403, detail="discussion_forbidden")


def require_project(repo: Repository, project_id: str, user: User) -> Project:
    return require_project_role(repo, project_id, user)[0]


def require_project_role(
    repo: Repository, project_id: str, user: User
) -> tuple[Project, Role]:
    """`require_project`, also returning the caller's workspace role it has
    already read — for a route that needs the role too, so it doesn't spend
    another database round trip asking again."""
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project_not_found")
    role = repo.get_membership(project.workspace_id, user.id)
    if role is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    tag_workspace(project.workspace_id)
    return project, role


def role_in(members: list[WorkspaceMember], user_id: str) -> Role | None:
    """The user's role in a workspace, from its member list already in hand."""
    return next((m.role for m in members if m.user_id == user_id), None)


def member_role(
    repo: Repository, workspace_id: str, members: list[WorkspaceMember], user_id: str
) -> Role | None:
    """The user's role from the member list, confirmed with `get_membership`
    when the list leaves them out. PostgREST caps a response at max_rows
    (supabase/config.toml), so in a workspace larger than that a real member
    can be missing from the list; the extra read happens only then."""
    role = role_in(members, user_id)
    return role if role is not None else repo.get_membership(workspace_id, user_id)


def require_project_members(
    repo: Repository, project_id: str, user: User
) -> tuple[Project, Role, list[WorkspaceMember]]:
    """`require_project_role` for a route that needs the workspace's member
    list as well: the caller's role is read from that list, so the membership
    check and the list are one database round trip, not two."""
    project = repo.get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project_not_found")
    members = repo.list_members(project.workspace_id)
    role = member_role(repo, project.workspace_id, members, user.id)
    if role is None:
        raise HTTPException(status_code=403, detail="not_a_member")
    tag_workspace(project.workspace_id)
    return project, role, members
