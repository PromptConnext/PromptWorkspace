"""Keep a created repository's seeded planning documents in step with the
project's stage documents.

`docs-status` rebuilds the seed (`build_seed_files`) and compares each
document view with the default branch's tree by git blob sha, so nothing is
fetched and nothing is stored. `sync-docs` commits the views that differ to a
`pw/sync-docs-<timestamp>` branch and opens one pull request, or adds to the
open one. It never writes to the default branch, never force-pushes and never
merges: a person reviews and merges the pull request.

While that pull request is open, both routes compare every document against
its branch as well (`classify_with_pull_request`): a view the branch already
carries reads `in_pull_request` and is not committed again, and a view the
branch holds differently (including one edited back to the default branch's
content) reads `out_of_date` and is committed onto it. Every write is pinned
to the branch head the comparison read, so a branch that moved in between
refuses instead of being written over.

Imported repositories are out of scope (plan Ruling 2): their seed was
relocated around the user's own files by `fit_to_existing_repo`, and
re-deriving that against a tree that now contains the seed would misread the
seeded files as conflicts.
"""

from __future__ import annotations

import logging
from typing import NamedTuple

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_project, require_stage_access

# The shared seed-input read: the same stage documents create_repository seeds from.
from app.api.sync import _seed_stage_docs
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.preview_url import repo_full_name_from_url
from app.integrations.github import (
    GithubBranchMovedError,
    GithubPullRequestExistsError,
    GithubRefUpdateRejectedError,
    GithubWriteError,
)
from app.integrations.github_auth import resolve_token
from app.integrations.repo_docs import (
    DocState,
    changed_files,
    classify_docs,
    classify_with_pull_request,
    files_differing_from,
    reverting_files,
)
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
    main_blobs: dict[str, str]


def _blobs(entries: list[dict]) -> dict[str, str]:
    return {e["path"]: e["sha"] for e in entries if e["type"] == "blob" and e.get("sha")}


def _read_failure(exc: GithubWriteError) -> HTTPException:
    """A read GitHub refused (a token that cannot see the repository answers
    401/403, or 404 for a private one) is the admin's to fix; anything else
    is transient."""
    if getattr(exc, "status_code", None) in (401, 403, 404):
        return HTTPException(status_code=400, detail="github_read_forbidden")
    return HTTPException(status_code=502, detail="github_unreachable")


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
        raise _read_failure(exc) from exc
    if truncated:
        raise HTTPException(status_code=409, detail="repo_tree_too_large")
    main_blobs = _blobs(entries)
    return _Status(
        classify_docs(seed_files, main_blobs),
        seed_files,
        token,
        full_name,
        default_branch,
        head_sha,
        main_blobs,
    )


async def _read_sync_branch(gh, status: _Status, branch: str) -> tuple[str, dict[str, str]]:
    """(head sha, path -> blob sha) of a sync branch: the open pull request's,
    or one an earlier sync left without an open pull request."""
    branch_head = await gh.get_branch_head(status.token, status.full_name, branch)
    entries, truncated = await gh.get_tree_entries(status.token, status.full_name, branch_head)
    if truncated:
        raise HTTPException(status_code=409, detail="repo_tree_too_large")
    return branch_head, _blobs(entries)


def _pr_body(differing: list[SeedFile], reverted: list[SeedFile]) -> str:
    parts = [
        "These files were regenerated from the project's planning documents in "
        "PromptWorkspace.\n"
    ]
    if differing:
        parts.append("\n".join(f"- `{f.path}`" for f in differing) + "\n")
    else:
        parts.append("No file differs from the default branch any more.\n")
    if reverted:
        parts.append(
            "Changed back to the default branch's content, because the planning "
            "document was edited back after an earlier sync:\n\n"
            + "\n".join(f"- `{f.path}`" for f in reverted)
            + "\n"
        )
    parts.append(
        "A file that was edited by hand in the repository also appears in this diff, "
        "so review each change rather than assuming the old content was meant to be "
        "overwritten.\n"
    )
    return "\n".join(parts)


@router.get(
    "/projects/{project_id}/repository/docs-status", response_model=RepositoryDocsStatus
)
async def docs_status(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RepositoryDocsStatus:
    """Which seeded planning documents differ from the default branch, and
    from the open sync pull request's branch. Any project member may read it."""
    project = require_project(repo, project_id, user)
    status = await _load_status(request, repo, project)
    gh = request.app.state.github_client

    states = status.states
    open_sync_pr: OpenSyncPr | None = None
    try:
        pr = await gh.find_open_pull_request(
            status.token, status.full_name, SYNC_BRANCH_PREFIX, status.default_branch
        )
    except GithubWriteError as exc:
        # The open pull request is decoration on the status, never an error.
        logger.warning("docs-status pull request lookup for %s failed: %s", status.full_name, exc)
        pr = None
    if pr is not None:
        open_sync_pr = OpenSyncPr(number=pr["number"], url=pr["html_url"])
        try:
            _, pr_blobs = await _read_sync_branch(gh, status, pr["head"])
            states = classify_with_pull_request(status.seed_files, status.main_blobs, pr_blobs)
        except (GithubWriteError, HTTPException) as exc:
            # Best-effort: without the branch, the default-branch comparison stands.
            logger.warning(
                "reading sync branch %s of %s failed: %s", pr["head"], status.full_name, exc
            )

    return RepositoryDocsStatus(
        files=[RepositoryDocFile(path=s.path, state=s.state) for s in states],
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

    async def find_pr() -> dict | None:
        """The open sync pull request; every lookup fails the same way."""
        try:
            return await gh.find_open_pull_request(
                token, full_name, SYNC_BRANCH_PREFIX, status.default_branch
            )
        except GithubWriteError as exc:
            logger.warning("sync-docs pull request lookup for %s failed: %s", full_name, exc)
            if getattr(exc, "status_code", None) in (403, 404):
                raise HTTPException(
                    status_code=400, detail="github_pr_permission_denied"
                ) from exc
            raise HTTPException(status_code=502, detail="github_sync_failed") from exc

    async def against(branch_name: str) -> tuple[str, list[DocState]]:
        try:
            branch_head, branch_blobs = await _read_sync_branch(gh, status, branch_name)
        except GithubWriteError as exc:
            logger.warning("reading sync branch %s of %s failed: %s", branch_name, full_name, exc)
            raise _read_failure(exc) from exc
        return branch_head, classify_with_pull_request(
            status.seed_files, status.main_blobs, branch_blobs
        )

    pr = await find_pr()
    if pr is None:
        # Named after the default-branch head, so two syncs racing from the
        # same head collide on the name instead of opening two pull requests.
        branch = SYNC_BRANCH_PREFIX + status.head_sha[:12]
        base_sha, states = status.head_sha, status.states
    else:
        branch = pr["head"]
        base_sha, states = await against(branch)
    changed = changed_files(status.seed_files, states)
    if not changed:
        raise HTTPException(status_code=409, detail="repository_docs_current")

    try:
        if pr is None:
            try:
                await gh.create_branch(token, full_name, branch, status.head_sha)
            except GithubBranchMovedError:
                # The name is taken: another sync's open pull request is the
                # one to add to. With none open, the branch belongs to a sync
                # still uploading or to a pull request closed without merging;
                # either way it is adopted, compared like an open pull
                # request's branch and written pinned to the head just read,
                # so a lost race refuses and a retry converges.
                pr = await find_pr()
                if pr is not None:
                    branch = pr["head"]
                base_sha, states = await against(branch)
                changed = changed_files(status.seed_files, states)
                if not changed and pr is not None:
                    raise HTTPException(
                        status_code=409, detail="repository_docs_current"
                    ) from None
        # An adopted branch may already hold every change; its pull request
        # still has to be opened below.
        if changed:
            await gh.create_commit_with_files(
                token, full_name, branch, changed, SYNC_TITLE, expected_base_sha=base_sha
            )
    except GithubBranchMovedError as exc:
        logger.warning("sync-docs onto %s of %s refused: %s", branch, full_name, exc)
        raise HTTPException(status_code=409, detail="github_branch_conflict") from exc
    except GithubRefUpdateRejectedError as exc:
        logger.warning("sync-docs onto %s of %s rejected by a rule: %s", branch, full_name, exc)
        raise HTTPException(status_code=409, detail="github_branch_protected") from exc
    except GithubWriteError as exc:
        logger.warning("sync-docs write for %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (401, 403, 404):
            raise HTTPException(status_code=400, detail="github_write_forbidden") from exc
        raise HTTPException(status_code=502, detail="github_sync_failed") from exc

    # The description lists every view that will differ from the default
    # branch once this commit lands, including those an earlier sync already
    # put on the branch, and names any view this commit changes back.
    body = _pr_body(
        files_differing_from(status.seed_files, status.main_blobs),
        reverting_files(changed, status.main_blobs),
    )
    try:
        if pr is None:
            try:
                pr = await gh.create_pull_request(
                    token, full_name, branch, status.default_branch, SYNC_TITLE, body
                )
            except GithubPullRequestExistsError:
                # Another sync on the same branch opened it first: add to it.
                pr = await find_pr()
                if pr is None:
                    raise
                await gh.update_pull_request(token, full_name, pr["number"], body)
        else:
            await gh.update_pull_request(token, full_name, pr["number"], body)
    except GithubWriteError as exc:
        # The sync branch already holds the commit; naming it lets an operator
        # find it. The next sync adopts it.
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
