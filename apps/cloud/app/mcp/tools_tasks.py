"""The three task tools of the hosted MCP server: list_my_tasks, get_task,
close_task. Same names and meaning as the stdio server (apps/mcp), minus
`workspace_root`: a hosted server has no clone to read.

Every tool takes its user from the verified bearer (`current_user()`), never
from an argument, and reads through the service-role repository only behind
the same checks the HTTP routes run: the membership-filtered
`assigned_tasks_for` (GET /me/tasks) and `require_project` plus
`apply_task_status` (PATCH .../status)."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, Literal

from fastapi import HTTPException
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from app.api._guards import require_project
from app.api.me import assigned_tasks_for
from app.api.sync import apply_task_status
from app.db.repository import Repository
from app.dependencies import User
from app.integrations.task_refs import task_ref_from_feature_tag
from app.mcp.auth import current_user
from app.models.schemas import (
    ArtifactAgent,
    ArtifactKind,
    AssignedTask,
    TaskStatus,
    TaskStatusArtifact,
    TaskStatusUpdate,
)

SPEC_EXCERPT_CHARS = 4000
_TRUNCATED = "\n\n…(truncated)"
_SLUG_MAX = 40  # packages/cloud-client/src/taskRefs.ts SLUG_MAX
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
# The ceiling GET /me/tasks allows; a task looked up by id is searched in all
# of the caller's assigned tasks, in every status.
_LOOKUP_LIMIT = 1000
_ALL_STATUSES = list(TaskStatus)

# HTTPException detail -> the sentence an agent reads after it.
_SENTENCES = {
    "not_a_member": "you are not a member of this task's workspace.",
    "status_forbidden": "only the task's assignee or a workspace admin can change its status.",
    "verified_requires_admin": "only a workspace admin can mark a task verified.",
    "task_not_found": "no such task is assigned to you; run list_my_tasks to see your tasks.",
    "project_not_found": "the task's project no longer exists.",
    "workspace_not_found": "the workspace no longer exists.",
}


def _tool_error(detail: str) -> ToolError:
    return ToolError(f"{detail}: {_SENTENCES.get(detail, 'the request was refused.')}")


def branch_name_for_task(ref: str, title: str) -> str:
    """Port of packages/cloud-client/src/taskRefs.ts::branchNameForTask."""
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    if len(slug) > _SLUG_MAX:
        boundary = slug.rfind("-", 0, _SLUG_MAX + 1)
        slug = slug[:boundary] if boundary > 0 else slug[:_SLUG_MAX]
    cut = slug.rstrip("-")
    return f"{ref}-{cut}" if cut else ref


def _find_assigned(repo: Repository, user: User, task_id: str) -> AssignedTask:
    for entry in assigned_tasks_for(
        repo, user, statuses=_ALL_STATUSES, limit=_LOOKUP_LIMIT
    ):
        if entry.task.id == task_id:
            return entry
    raise _tool_error("task_not_found")


def _summary(entry: AssignedTask) -> dict[str, Any]:
    task = entry.task
    return {
        "task_id": task.id,
        "ref": task_ref_from_feature_tag(task.feature_tag),
        "title": task.title,
        "status": task.status.value,
        "project_id": entry.project_id,
        "project": entry.project_name,
        "workspace_id": entry.workspace_id,
        "workspace": entry.workspace_name,
        "repo_url": entry.repo_url,
    }


def _spec_excerpt(repo: Repository, entry: AssignedTask) -> str | None:
    spec_id = entry.task.spec_id
    if not spec_id:
        return None
    spec = repo.get_node(entry.project_id, "spec_documents", spec_id)
    content = getattr(spec, "content", "") or ""
    if not content:
        return None
    if len(content) > SPEC_EXCERPT_CHARS:
        return content[:SPEC_EXCERPT_CHARS] + _TRUNCATED
    return content


def _constitution_present(repo: Repository, project_id: str) -> bool:
    doc = repo.get_stage_document(project_id, "constitution")
    return bool(doc is not None and (doc.content or "").strip())


def register_task_tools(
    server: MCPServer,
    repo_provider: Callable[[], Repository],
    app_provider: Callable[[], Any] | None = None,
) -> None:
    @server.tool(structured_output=True)
    def list_my_tasks(
        workspace_id: str | None = None, status: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """Tasks assigned to you in PromptWorkspace, across your workspaces.
        Defaults to open work (todo and in_progress); pass `status` for others
        (todo, in_progress, implemented, verified). Each entry carries the
        task_id that get_task and close_task take."""
        user = current_user()
        statuses: list[TaskStatus] | None = None
        if status:
            try:
                statuses = [TaskStatus(s) for s in status]
            except ValueError as err:
                raise ToolError(
                    "invalid_status: status must be todo, in_progress, implemented or verified."
                ) from err
        return [
            _summary(e)
            for e in assigned_tasks_for(
                repo_provider(), user, workspace_id=workspace_id, statuses=statuses
            )
        ]

    @server.tool(structured_output=True)
    def get_task(task_id: str) -> dict[str, Any]:
        """Everything needed to work on one of your tasks: acceptance criteria,
        a spec excerpt, the repository, the branch name and the commit prefix
        that closes it."""
        user = current_user()
        repo = repo_provider()
        entry = _find_assigned(repo, user, task_id)
        task = entry.task
        ref = task_ref_from_feature_tag(task.feature_tag)
        prefix = f"{ref}:" if ref else None
        if ref:
            how = (
                f"Commit with `{ref}: <what you did>` in the subject, push, then call "
                f"close_task with task_id {task.id}, status implemented and the commit sha."
            )
        else:
            how = (
                f"Commit and push, then call close_task with task_id {task.id}, "
                "status implemented and the commit sha."
            )
        return {
            "task_id": task.id,
            "title": task.title,
            "ref": ref,
            "branch_name": branch_name_for_task(ref, task.title) if ref else None,
            "commit_prefix": prefix,
            "status": task.status.value,
            "project_id": entry.project_id,
            "project": entry.project_name,
            "workspace_id": entry.workspace_id,
            "workspace": entry.workspace_name,
            "repo_url": entry.repo_url,
            "acceptance_criteria": [c.text for c in task.acceptance_criteria],
            "spec_excerpt": _spec_excerpt(repo, entry),
            "constitution_present": _constitution_present(repo, entry.project_id),
            "how_to_close": how,
        }

    @server.tool(structured_output=True)
    def close_task(
        task_id: str,
        status: Literal["in_progress", "implemented", "verified"],
        commit_sha: str | None = None,
    ) -> dict[str, Any]:
        """Set the status of one of your tasks. `implemented` requires the
        40-character `commit_sha` that did the work, recorded as evidence.
        `verified` is for workspace admins only."""
        user = current_user()
        artifact = None
        if commit_sha is not None and not _SHA_RE.match(commit_sha):
            raise ToolError("invalid_commit_sha: commit_sha must be a full 40-character hex sha.")
        if status == "implemented" and commit_sha is None:
            raise ToolError(
                "commit_sha_required: pass commit_sha (the full 40-character sha) "
                "when setting status implemented."
            )
        if commit_sha is not None:
            sha = commit_sha.lower()
            artifact = TaskStatusArtifact(
                commit_sha=sha,
                uri=f"git: {sha}",
                kind=ArtifactKind.code,
                agent=ArtifactAgent(client="hosted-mcp"),
            )
        repo = repo_provider()
        entry = _find_assigned(repo, user, task_id)
        try:
            project = require_project(repo, entry.project_id, user)
            updated = apply_task_status(
                repo,
                app_provider() if app_provider else None,
                project,
                user,
                task_id,
                TaskStatusUpdate(status=TaskStatus(status), artifact=artifact),
            )
        except HTTPException as err:
            raise _tool_error(str(err.detail)) from err
        return {
            "task_id": updated.id,
            "title": updated.title,
            "status": updated.status.value,
            "project": entry.project_name,
            "workspace": entry.workspace_name,
            "commit_sha": artifact.commit_sha if artifact else None,
        }
