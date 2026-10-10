"""Keep a created repository's seeded planning documents in step with the
project's stage documents.

`docs-status` rebuilds the seed (`build_seed_files`) and compares each
document view with the default branch's tree by git blob sha, so nothing is
fetched and nothing is stored. `sync-docs` commits the views that differ to a
`pw/sync-docs-<timestamp>` branch and opens one pull request, or adds to the
open one. It never writes to the default branch, never force-pushes and never
merges: a person reviews and merges the pull request.

Imported repositories are out of scope (plan Ruling 2): their seed was
relocated around the user's own files by `fit_to_existing_repo`, and
re-deriving that against a tree that now contains the seed would misread the
seeded files as conflicts.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_project, require_stage_access

# The shared seed-input read: the same stage documents create_repository seeds from.
from app.api.sync import _seed_stage_docs
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.preview_url import repo_full_name_from_url
from app.integrations.github import GithubBranchMovedError, GithubWriteError
from app.integrations.github_auth import resolve_token
from app.integrations.repo_docs import DocState, changed_files, classify_docs
from app.integrations.repo_seed import SeedFile, build_seed_files
from app.models.schemas import (
    OpenSyncPr,
    Project,
    RepositoryDocFile,
    RepositoryDocsStatus,
    SyncDocsOut,
)

router = APIRouter(tags=["repository-docs"])
logger = logging.getLogger("promptworkspace.repository_docs")

SYNC_BRANCH_PREFIX = "pw/sync-docs-"
SYNC_TITLE = "docs: sync planning documents from PromptWorkspace"


class _Status(NamedTuple):
    states: list[DocState]
    seed_files: list[SeedFile]
    token: str
    full_name: str
    default_branch: str
    head_sha: str


async def _load_status(request: Request, repo: Repository, project: Project) -> _Status:
    if project.lifecycle_status != "repo_created" or not project.repo_url:
        raise HTTPException(status_code=409, detail="repository_not_created")
    # A repository-created project with no recorded origin predates
    # `repo_origin` and may be an import; the migration's rule reads NULL as
    # imported, and `is_imported` alone answers False once `repo_created`.
    if project.is_imported or project.repo_origin != "created":
        raise HTTPException(status_code=409, detail="sync_not_supported_for_imported_repository")

    workspace = repo.get_workspace(project.workspace_id)
    resolved = resolve_token(request.app, workspace)
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, _ = resolved
    full_name = repo_full_name_from_url(project.repo_url)
    if full_name is None:
        raise HTTPException(status_code=409, detail="repo_url_unrecognized")

    seed_files = build_seed_files(project, _seed_stage_docs(repo, project.id))

    gh = request.app.state.github_client
    default_branch = project.repo_default_branch or "main"
    try:
        head_sha = await gh.get_branch_head(token, full_name, default_branch)
        entries, truncated = await gh.get_tree_entries(token, full_name, head_sha)
    except GithubWriteError as exc:
        logger.warning("docs-status read for %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (401, 403):
            raise HTTPException(status_code=400, detail="github_read_forbidden") from exc
        raise HTTPException(status_code=502, detail="github_unreachable") from exc
    if truncated:
        raise HTTPException(status_code=409, detail="repo_tree_too_large")
    tree_blobs = {e["path"]: e["sha"] for e in entries if e["type"] == "blob" and e.get("sha")}
    return _Status(
        classify_docs(seed_files, tree_blobs),
        seed_files,
        token,
        full_name,
        default_branch,
        head_sha,
    )


def _pr_body(changed: list[SeedFile]) -> str:
    paths = "\n".join(f"- `{f.path}`" for f in changed)
    return (
        "These files were regenerated from the project's planning documents in "
        "PromptWorkspace.\n\n"
        f"{paths}\n\n"
        "A file that was edited by hand in the repository also appears in this diff, "
        "so review each change rather than assuming the old content was meant to be "
        "overwritten.\n"
    )


@router.get(
    "/projects/{project_id}/repository/docs-status", response_model=RepositoryDocsStatus
)
async def docs_status(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RepositoryDocsStatus:
    """Which seeded planning documents differ from the default branch. Any
    project member may read it."""
    project = require_project(repo, project_id, user)
    status = await _load_status(request, repo, project)

    open_sync_pr: OpenSyncPr | None = None
    try:
        pr = await request.app.state.github_client.find_open_pull_request(
            status.token, status.full_name, SYNC_BRANCH_PREFIX
        )
    except GithubWriteError as exc:
        # The open pull request is decoration on the status, never an error.
        logger.warning("docs-status pull request lookup for %s failed: %s", status.full_name, exc)
        pr = None
    if pr is not None:
        open_sync_pr = OpenSyncPr(number=pr["number"], url=pr["html_url"])

    return RepositoryDocsStatus(
        files=[RepositoryDocFile(path=s.path, state=s.state) for s in status.states],
        open_sync_pr=open_sync_pr,
    )


@router.post("/projects/{project_id}/repository/sync-docs", response_model=SyncDocsOut)
async def sync_docs(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> SyncDocsOut:
    """Commit the out-of-date document views to a sync branch and open (or
    update) the one sync pull request. Admin-only, like authoring the plan."""
    project = require_project(repo, project_id, user)
    require_stage_access(repo, project, "plan", user)
    status = await _load_status(request, repo, project)
    gh = request.app.state.github_client
    token, full_name = status.token, status.full_name

    changed = changed_files(status.seed_files, status.states)
    if not changed:
        raise HTTPException(status_code=409, detail="repository_docs_current")

    try:
        pr = await gh.find_open_pull_request(token, full_name, SYNC_BRANCH_PREFIX)
    except GithubWriteError as exc:
        logger.warning("sync-docs pull request lookup for %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (403, 404):
            raise HTTPException(status_code=400, detail="github_pr_permission_denied") from exc
        raise HTTPException(status_code=502, detail="github_sync_failed") from exc

    try:
        if pr is None:
            branch = SYNC_BRANCH_PREFIX + datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
            await gh.create_branch(token, full_name, branch, status.head_sha)
        else:
            branch = pr["head"]
        await gh.create_commit_with_files(token, full_name, branch, changed, SYNC_TITLE)
    except GithubBranchMovedError as exc:
        raise HTTPException(status_code=409, detail="github_branch_conflict") from exc
    except GithubWriteError as exc:
        logger.warning("sync-docs write for %s failed: %s", full_name, exc)
        raise HTTPException(status_code=502, detail="github_sync_failed") from exc

    body = _pr_body(changed)
    try:
        if pr is None:
            pr = await gh.create_pull_request(
                token, full_name, branch, status.default_branch, SYNC_TITLE, body
            )
        else:
            await gh.update_pull_request(token, full_name, pr["number"], body)
    except GithubWriteError as exc:
        # The sync branch already holds the commit; naming it lets an operator
        # find (or delete) a branch left without a pull request.
        logger.warning(
            "sync-docs pull request for %s failed, branch %s left without one: %s",
            full_name,
            branch,
            exc,
        )
        if getattr(exc, "status_code", None) in (403, 404):
            raise HTTPException(status_code=400, detail="github_pr_permission_denied") from exc
        raise HTTPException(status_code=502, detail="github_sync_failed") from exc

    return SyncDocsOut(
        pr_number=pr["number"],
        pr_url=pr["html_url"],
        branch=branch,
        files=[f.path for f in changed],
    )
