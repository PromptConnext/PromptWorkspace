"""Discussion authoring API (M12).

  POST /projects/{id}/discussions   member — create a pw-native comment

The one deliberate exception to the "read-first, authoring stays on
desktop" rule (M8): comments are collaboration data, not planning
artifacts, so both web and desktop may author them. Reads aren't a new
endpoint — discussions ride the existing `GET /sync/projects/{id}/graph`
(`ProjectGraph.discussions`), same as every other entity.

`author` is always the authenticated caller, never client-supplied, and
`source` is always "pz" here — the only other writer of pw_discussions rows
is the Jira comment mirror (app/api/integrations.py), which pushes
source="pmo" through the same repo.upsert_graph() path this endpoint uses.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_project
from app.db.repository import Repository
from app.delivery import line_notices
from app.dependencies import User, get_current_user, get_repository
from app.models.schemas import (
    ENTITY_TYPES,
    Discussion,
    DiscussionCreate,
    GraphUpsertRequest,
    Project,
    Task,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

logger = logging.getLogger(__name__)
router = APIRouter(tags=["discussions"])

_VALID_PARENT_TYPES = {t for t in ENTITY_TYPES if t != "discussions"}


@router.post("/projects/{project_id}/discussions", response_model=Discussion, status_code=201)
def create_discussion(
    project_id: str,
    body: DiscussionCreate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Discussion:
    project = require_project(repo, project_id, user)
    if body.parent_node_type not in _VALID_PARENT_TYPES:
        raise HTTPException(status_code=422, detail="invalid_parent_node_type")
    if repo.get_node(project_id, body.parent_node_type, body.parent_node_id) is None:
        raise HTTPException(status_code=404, detail="parent_node_not_found")

    discussion = Discussion(
        project_id=project_id,
        parent_node_type=body.parent_node_type,
        parent_node_id=body.parent_node_id,
        author=user.id,
        body=body.body,
        source="pz",
    )
    repo.upsert_graph(project_id, GraphUpsertRequest(discussions=[discussion]), source="pz")

    # Embed-on-ingest, same rule as sync.py's push handler: never block this
    # request on a model call, just enqueue.
    if "discussions" in RAG_NODE_TYPES:
        enqueue(
            request.app,
            EmbedJob(project.workspace_id, project_id, "discussions", discussion.id),
        )

    try:
        _notify_line(request, project, user, discussion, repo)
    except Exception:
        logger.exception("discussion LINE notice failed, project=%s", project_id)

    return discussion


def _about(
    repo: Repository, project_id: str, node_type: str, node_id: str
) -> tuple[str | None, str | None, str | None]:
    """(kind, ref, title) for `about_label`; no kind means "the project"."""
    node = repo.get_node(project_id, node_type, node_id)
    if node_type == "tasks" and isinstance(node, Task):
        # "T012 [P]" carries the parallel marker; the reference is "T012".
        return "task", (node.feature_tag or "").removesuffix(" [P]"), node.title
    if node_type == "spec_documents":
        return "spec", None, None
    stage = getattr(node, "stage", None) if node_type == "stage_documents" else None
    if stage in ("specify", "plan"):
        return ("spec" if stage == "specify" else "plan"), None, None
    return None, None, None


def _notify_line(
    request: Request, project: Project, user: User, discussion: Discussion, repo: Repository
) -> None:
    state = request.app.state
    notifier = state.line_notifier
    # Nothing to send: read nothing more and leave the window untouched.
    if not notifier.enabled:
        return
    # One cheap read on the request thread, so a comment made while the project
    # is unlinked never uses up the window. The throttle stays here too (rather
    # than on the two-thread worker) so it sees comments in request order.
    if repo.get_project_line_link(project.id) is None:
        return
    burst = state.discussion_throttle.allow(
        project.id, discussion.parent_node_id, user.id, utcnow()
    )
    if burst is None:
        return
    web = state.settings.web_app_url.rstrip("/")
    link = f"{web}/w/{project.workspace_id}/p/{project.id}?tab=discussion"
    node_type, node_id = discussion.parent_node_type, discussion.parent_node_id

    def build(lang: line_notices.Lang) -> str:
        # Runs on the LINE worker: these lookups stay off the request thread.
        emails = {m.user_id: m.email for m in repo.list_members(project.workspace_id)}
        emails[user.id] = emails.get(user.id) or user.email
        authors = [emails[a] for a in burst.authors if emails.get(a)] or ["Someone"]
        about = line_notices.about_label(*_about(repo, project.id, node_type, node_id), lang)
        if burst.count == 1:
            return line_notices.discussion(project.name, authors[0], about, link, lang)
        return line_notices.discussion_batch(
            project.name, burst.count, about, authors, link, lang
        )

    notifier.notify_project(project.id, build)
