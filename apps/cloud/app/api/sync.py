"""Projects + Sync API.

The local engine is the source of truth; the cloud holds the shared graph so
collaborators (and business stakeholders) see the same requirement -> spec ->
task -> agent-run -> progress lineage.

Endpoints (this milestone):
  POST /projects                     create a project
  GET  /projects                     list caller's projects
  GET  /projects/{id}                fetch one project
  PUT  /sync/projects/{id}/graph     push a graph delta (upsert)
  GET  /sync/projects/{id}/graph     pull the graph (optionally ?since= cursor)
"""

from __future__ import annotations

import logging
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api._guards import require_project, require_workspace
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.integrations.github import GithubWriteError, RepoAlreadyExistsError
from app.integrations.repo_seed import build_seed_files
from app.models.schemas import (
    ENTITY_TYPES,
    ChangesHead,
    CreateRepositoryRequest,
    GraphUpsertRequest,
    GraphUpsertResponse,
    Project,
    ProjectCreate,
    ProjectGraph,
    Role,
    Task,
    TaskAssignmentUpdate,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

# The four Spec Kit stages a project's repo is seeded from (Phase 3,
# app/integrations/repo_seed.py). Order doesn't matter here — build_seed_files
# reads them by name.
_SEED_STAGES = ("constitution", "specify", "plan", "tasks")


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "project"

router = APIRouter(tags=["sync"])
logger = logging.getLogger("promptconnext.sync")


@router.post("/projects", response_model=Project, status_code=201)
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    # Only members of the target workspace may create projects in it.
    require_workspace(repo, body.workspace_id, user)
    return repo.create_project(
        workspace_id=body.workspace_id, created_by=user.id, name=body.name
    )


@router.get("/projects", response_model=list[Project])
def list_projects(
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[Project]:
    return repo.list_projects(user_id=user.id)


@router.get("/projects/{project_id}", response_model=Project)
def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    return require_project(repo, project_id, user)


@router.post("/projects/{project_id}/lifecycle/submit-for-review", response_model=Project)
def submit_for_review(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Business user signals planning is done (explicit — a Tech Lead
    shouldn't be pulled in on a project still being iterated). No side
    effect beyond the status flip; the Tech Lead's own actions drive
    everything after this (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md)."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status != "planning":
        raise HTTPException(status_code=409, detail="not_in_planning")

    graph = repo.get_graph(project_id)
    if not (graph.requirements and graph.spec_documents and graph.tasks):
        raise HTTPException(status_code=400, detail="planning_incomplete")

    return repo.update_project_lifecycle_status(project_id, "pending_tech_review")


@router.post("/projects/{project_id}/lifecycle/start-tech-review", response_model=Project)
def start_tech_review(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """The design doc calls this transition "automatic on first Tech Lead
    interaction" — the web client may fire it repeatedly as the Tech Lead
    opens the project, so it's deliberately idempotent once in `tech_review`
    rather than erroring on a second call."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status == "tech_review":
        return project
    if project.lifecycle_status != "pending_tech_review":
        raise HTTPException(status_code=409, detail="not_pending_tech_review")
    return repo.update_project_lifecycle_status(project_id, "tech_review")


@router.post("/projects/{project_id}/lifecycle/create-repository", response_model=Project)
async def create_repository(
    project_id: str,
    body: CreateRepositoryRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Creates the GitHub repo at the `tech_review -> repo_created` exit and
    seeds it with AI context derived from the project's stage documents
    (app/integrations/repo_seed.py). Repo creation is external and
    non-transactional, so ordering is the correctness requirement here:
    seed files are built *before* any GitHub call (cheap, fails fast), the
    repo is created (or an existing one from a prior partial attempt is
    adopted), every seed file is committed, and only once all of that
    succeeds does the project's `repo_url` get persisted — followed by the
    lifecycle flip to `repo_created`. That order means the worst crash
    window leaves `repo_url` set with status still `tech_review`, which a
    retry recognizes as adoptable; never the reverse, which would strand a
    project as `repo_created` with no repo behind it."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status == "repo_created":
        return project
    if project.lifecycle_status != "tech_review":
        raise HTTPException(status_code=409, detail="not_in_tech_review")

    workspace = repo.get_workspace(project.workspace_id)
    github_config = (workspace.integration_config or {}).get("github") if workspace else None
    if not github_config:
        raise HTTPException(status_code=400, detail="github_not_configured")

    installation_id = github_config.get("installation_id")
    owner = github_config.get("owner") or (github_config.get("repo") or "").split("/")[0] or None
    settings = request.app.state.settings
    if not installation_id or not owner or not (
        settings.github_app_id and settings.github_app_private_key
    ):
        raise HTTPException(status_code=400, detail="github_not_configured")

    # Step 2: assemble seed files before any external mutation. Cheap and
    # pure (app/integrations/repo_seed.py) — fail fast on nothing external.
    stage_docs = {
        stage: (doc.content if doc else None)
        for stage, doc in (
            (s, repo.get_stage_document(project_id, s)) for s in _SEED_STAGES
        )
    }
    seed_files = build_seed_files(project, stage_docs)

    github_client = request.app.state.github_client
    token = await github_client.mint_installation_token(
        settings.github_app_id, settings.github_app_private_key, installation_id
    )

    name = body.name or _slugify(project.name)
    description = f"PromptZone-managed repository for project {project.id}"

    try:
        created = await github_client.create_org_repo(
            token, owner, name, description, body.private
        )
    except RepoAlreadyExistsError:
        # Retry path after a mid-flight failure: adopt the repo we (likely)
        # created on a previous attempt rather than failing outright.
        existing = await github_client.get_repo(token, f"{owner}/{name}")
        if existing is None:
            raise HTTPException(status_code=409, detail="repo_name_taken") from None
        created = existing
    except GithubWriteError as exc:
        raise HTTPException(status_code=502, detail="github_repo_create_failed") from exc

    full_name = created["full_name"]
    default_branch = created.get("default_branch") or "main"

    try:
        for seed_file in seed_files:
            await github_client.put_file_content(
                token,
                full_name,
                seed_file.path,
                seed_file.content,
                message=f"chore: seed {seed_file.path} from PromptZone",
                branch=default_branch,
            )
    except GithubWriteError as exc:
        # Do NOT advance the lifecycle — a partially seeded repo must leave
        # repo_url unset so a retry re-enters at repo creation and adopts.
        raise HTTPException(status_code=502, detail="github_seed_failed") from exc

    # Step 6: repo-write first, lifecycle flip last — see docstring.
    repo.update_project_repo(project_id, created["html_url"], default_branch)
    return repo.update_project_lifecycle_status(project_id, "repo_created")


@router.patch("/projects/{project_id}/tasks/{task_id}/assignment", response_model=Task)
def assign_task(
    project_id: str,
    task_id: str,
    body: TaskAssignmentUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Task:
    project = require_project(repo, project_id, user)  # membership-gated
    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    caller_role = repo.get_membership(project.workspace_id, user.id)
    target = body.assigned_user_id

    # Permission: admins assign/clear anyone; a member may only assign a task
    # to themselves or clear a task currently assigned to themselves.
    if caller_role != Role.admin:
        self_assign = target == user.id and target is not None
        self_unassign = target is None and task.assigned_user_id == user.id
        if not (self_assign or self_unassign):
            raise HTTPException(status_code=403, detail="assignment_forbidden")

    # Target must be a current member of the task's workspace (null = unassign).
    if target is not None:
        member_ids = {m.user_id for m in repo.list_members(project.workspace_id)}
        if target not in member_ids:
            raise HTTPException(status_code=400, detail="assignee_not_a_member")

    return repo.assign_task(project_id, task_id, target, utcnow())


@router.put("/sync/projects/{project_id}/graph", response_model=GraphUpsertResponse)
def push_graph(
    project_id: str,
    payload: GraphUpsertRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GraphUpsertResponse:
    project = require_project(repo, project_id, user)
    counts, conflicts = repo.upsert_graph(project_id, payload, source=payload.source)
    cursor, _ = repo.changes_head(project_id)
    total = sum(counts.values())
    metrics = getattr(request.app.state, "metrics", None)
    if metrics is not None:
        metrics["pushed"] += 1
        metrics["merged"] += total
    logger.info(
        "graph push project=%s user=%s source=%s counts=%s",
        project_id,
        user.id,
        payload.source,
        counts,
    )
    # Embed-on-ingest (M9): enqueue only, never block this push on a model
    # call. The worker skips nodes whose workspace has no model connection.
    # Only entity types that are both syncable (ENTITY_TYPES, i.e. actual
    # GraphUpsertRequest fields) and RAG-indexable (RAG_NODE_TYPES) apply —
    # RAG_NODE_TYPES also carries types with no sync-payload field at all
    # (M11's "pull_requests", indexed from a GitHub webhook, not a push).
    for node_type in ENTITY_TYPES:
        if node_type not in RAG_NODE_TYPES:
            continue
        for item in getattr(payload, node_type):
            enqueue(
                request.app,
                EmbedJob(project.workspace_id, project_id, node_type, item.id),
            )
    return GraphUpsertResponse(upserted=counts, cursor=cursor, conflicts=conflicts)


@router.get("/sync/projects/{project_id}/changes", response_model=ChangesHead)
def changes_head(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Cursor from the last pull; counts reflect changes strictly after it.",
    ),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ChangesHead:
    """Cheap sync head so a polling client can decide whether to pull. When
    `since == head` (nothing new) `has_changes` is False and the client skips
    the full graph pull entirely."""
    require_project(repo, project_id, user)
    cursor, counts = repo.changes_head(project_id, since=since)
    return ChangesHead(cursor=cursor, counts=counts, has_changes=bool(counts))


@router.get("/sync/projects/{project_id}/graph", response_model=ProjectGraph)
def pull_graph(
    project_id: str,
    since: datetime | None = Query(
        default=None,
        description="Return only entities updated strictly after this timestamp.",
    ),
    limit: int | None = Query(
        default=None, ge=1, le=5000, description="Max rows in this page (keyset paginated)."
    ),
    after_ts: datetime | None = Query(
        default=None, description="Keyset continuation: last page's cursor."
    ),
    after_id: str | None = Query(
        default=None, description="Keyset continuation: last page's next_id."
    ),
    request: Request = None,  # type: ignore[assignment]
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> ProjectGraph:
    require_project(repo, project_id, user)
    metrics = getattr(request.app.state, "metrics", None) if request else None
    if metrics is not None:
        metrics["pulled"] += 1
    return repo.get_graph(
        project_id, since=since, limit=limit, after_ts=after_ts, after_id=after_id
    )
