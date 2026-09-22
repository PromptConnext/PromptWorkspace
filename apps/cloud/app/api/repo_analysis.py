"""Repository analysis for an imported project (plan 0027 M2).

A project imported from an existing repository used to be planned as if it
started from nothing: the stages never saw its code. This router is where the
platform reads that code — a deterministic snapshot (app/imports/snapshot.py)
plus one model-written "codebase baseline" over it — and stores the result for
app/api/generation.py to feed into the stages and to gate `plan`/`tasks` on.

Endpoints:
  POST  /projects/{id}/repo-analysis     admin — snapshot, then stream the baseline (SSE)
  GET   /projects/{id}/repo-analysis     member — the stored analysis, with `stale`
  PATCH /projects/{id}/repo-analysis     admin — edit the baseline by hand

Admin-only on both writes because the analysis is Tech Lead input: it decides
what the plan is written against, and `plan` is already an admin-only stage
(app/api/_guards.py::ADMIN_ONLY_STAGES). The baseline costs the workspace's
daily token budget (ADR 0027), so it is generated only when asked and stored,
never regenerated on its own — a push that makes it stale is reported, not
acted on.
"""

from __future__ import annotations

import json
import logging
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.api._guards import require_admin, require_project
from app.api.generation import _resolve_model, requires_repo_analysis
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.preview_url import repo_full_name_from_url
from app.generation.parsing import extract_document, parse_files, strip_thinking
from app.generation.prompts import codebase_baseline_prompt, codebase_baseline_user_content
from app.generation.service import HttpGenerationProvider
from app.imports.snapshot import build_snapshot
from app.integrations.github import GithubWriteError
from app.integrations.github_auth import resolve_token
from app.models.schemas import (
    GenerationRun,
    Project,
    RepoAnalysis,
    RepoAnalysisBaselineUpdate,
    RepoAnalysisOut,
    Role,
)
from app.rag.budget import estimate_tokens

logger = logging.getLogger("promptconnext.repo_analysis")
router = APIRouter(tags=["repo_analysis"])

# `generation_runs.stage` for a baseline run — free text there, the same way
# prefill records "prefill:<stage>".
_RUN_STAGE = "codebase_baseline"

# `stale` costs a GitHub round trip, and the Planner asks on every render. One
# answer per project per minute is plenty for "has the branch moved"; the app
# is single-instance (CLAUDE.md, Deployment), so an in-process dict is the
# whole cache. project_id -> (monotonic time, analysed commit, stale).
_STALE_TTL_SECONDS = 60.0
_stale_cache: dict[str, tuple[float, str, bool]] = {}


def _out(
    project: Project,
    analysis: RepoAnalysis | None,
    stale: bool | None = None,
    *,
    include_excerpts: bool = True,
):
    """`include_excerpts=False` empties `snapshot.excerpts` and nothing else:
    they are verbatim file contents, which only the admins who ran the
    analysis see — members get the same shape with an empty list."""
    if analysis is None:
        return RepoAnalysisOut(
            project_id=project.id, status="none", required=requires_repo_analysis(project)
        )
    snapshot = analysis.snapshot
    if not include_excerpts:
        snapshot = snapshot.model_copy(update={"excerpts": []})
    return RepoAnalysisOut(
        project_id=project.id,
        status=analysis.status,
        required=requires_repo_analysis(project),
        commit_sha=analysis.commit_sha,
        snapshot=snapshot,
        baseline=analysis.baseline,
        updated_at=analysis.updated_at,
        stale=stale,
    )


def _github_access(request: Request, repo: Repository, project: Project) -> tuple[str, str]:
    """(token, repo full name) for the project's imported repository, with the
    same owner re-check create_repository makes: the workspace may have been
    reconnected to a different owner since the import, and the token in hand
    belongs to the current one."""
    workspace = repo.get_workspace(project.workspace_id)
    resolved = resolve_token(request.app, workspace)
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, github_config = resolved
    owner = github_config.get("owner")
    if not owner:
        raise HTTPException(status_code=400, detail="github_not_configured")
    full_name = repo_full_name_from_url(project.repo_url)
    if full_name is None:
        raise HTTPException(status_code=409, detail="repo_url_unrecognized")
    if full_name.split("/")[0].lower() != owner.lower():
        raise HTTPException(status_code=400, detail="repo_owner_out_of_scope")
    return token, full_name


def _baseline_from(raw: str) -> str:
    """The document out of a completion: the fenced file if the model used
    one, the first H1 onward if it didn't, the whole stripped text failing
    both — a baseline is prose for people and prompts, not a parsed graph, so
    a model that ignored the wrapper still produced something usable."""
    cleaned = strip_thinking(raw)
    files = parse_files(cleaned)
    if files:
        return files[0]["content"].strip()
    return (extract_document(cleaned) or cleaned).strip()


@router.post("/projects/{project_id}/repo-analysis")
async def analyze_repository(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StreamingResponse:
    """Snapshot the imported repository, store it, then stream one baseline
    generation over it.

    SSE, in the shape `POST .../generate/{stage}` already uses: one
    `event: snapshot` carrying the stored analysis (status `snapshot_ready`)
    as soon as the repository has been read, `data: {"delta": ...}` lines
    while the model writes, then `event: done` with the final analysis — or
    `event: error` with `{"error", "retryable"}`, after which the stored
    status is `failed` and the snapshot is kept.

    Everything that can refuse — role, project state, GitHub access, model
    and budget — refuses as a plain HTTP error before the stream opens.
    """
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    if not project.is_imported:
        raise HTTPException(status_code=409, detail="repo_not_imported")
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="repo_already_created")

    token, full_name = _github_access(request, repo, project)
    conn = _resolve_model(request, project)

    github_client = request.app.state.github_client
    try:
        snapshot = await build_snapshot(
            github_client, token, full_name, project.repo_default_branch or "main"
        )
    except GithubWriteError as exc:
        logger.warning("snapshot of %s failed: %s", full_name, exc)
        status = getattr(exc, "status_code", None)
        if status in (401, 403):
            raise HTTPException(status_code=400, detail="github_repo_not_in_token_scope") from exc
        if status == 404:
            raise HTTPException(status_code=409, detail="imported_repo_not_found") from exc
        raise HTTPException(status_code=502, detail="github_unreachable") from exc

    # A re-analysis replaces the previous one outright, baseline included: a
    # baseline describing a commit the snapshot no longer matches would feed
    # the stages two different repositories.
    analysis = repo.upsert_repo_analysis(
        RepoAnalysis(
            project_id=project.id,
            workspace_id=project.workspace_id,
            commit_sha=snapshot.commit_sha,
            snapshot=snapshot,
            status="snapshot_ready",
            created_by=user.id,
        )
    )

    api_key = request.app.state.secret_store.decrypt(conn.secret_ref)
    provider = getattr(request.app.state, "generation_provider", None) or HttpGenerationProvider()
    system_prompt = codebase_baseline_prompt()
    user_content = codebase_baseline_user_content(full_name, snapshot)
    max_tokens = request.app.state.settings.managed_model_max_tokens
    budget = request.app.state.token_budget

    run = repo.create_generation_run(
        GenerationRun(
            workspace_id=project.workspace_id,
            project_id=project.id,
            stage=_RUN_STAGE,
            model_source=conn.source,
            model=conn.model,
        )
    )

    def _fail(prompt_tokens: int, completion_tokens: int) -> None:
        repo.update_generation_run(
            run.id,
            status="failed",
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        repo.upsert_repo_analysis(analysis.model_copy(update={"status": "failed"}))

    prompt_tokens = estimate_tokens(system_prompt) + estimate_tokens(user_content)

    async def stream():
        parts: list[str] = []
        finish: list[str | None] = [None]
        # `settled`: the run and the analysis have their final status. Set
        # before the last event is yielded, so a client that disconnects on
        # that very event cannot turn a stored baseline into `failed`.
        # `recorded`: the budget has been charged for this run.
        settled = False
        recorded = False
        try:
            yield (
                "event: snapshot\n"
                f"data: {_out(project, analysis).model_dump_json()}\n\n"
            )
            try:
                async for delta in provider.stream(
                    system_prompt,
                    user_content,
                    conn.model,
                    api_key,
                    conn.base_url,
                    max_tokens=max_tokens,
                    on_finish=lambda reason: finish.__setitem__(0, reason),
                ):
                    parts.append(delta)
                    yield f"data: {json.dumps({'delta': delta})}\n\n"
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                settled = True
                _fail(0, 0)
                message = (
                    "managed tier busy, try again later"
                    if status == 429
                    else f"model provider error ({status})"
                )
                payload = {"error": message, "retryable": status == 429}
                yield f"event: error\ndata: {json.dumps(payload)}\n\n"
                return
            except httpx.HTTPError as exc:
                # A connection that dropped or timed out mid-stream: whatever
                # the model produced before it still cost the budget.
                logger.warning("baseline stream for project %s failed: %s", project.id, exc)
                completion_tokens = estimate_tokens("".join(parts))
                budget.record(project.workspace_id, prompt_tokens + completion_tokens)
                recorded = True
                settled = True
                _fail(prompt_tokens, completion_tokens)
                payload = {"error": "model provider unreachable", "retryable": True}
                yield f"event: error\ndata: {json.dumps(payload)}\n\n"
                return

            raw = "".join(parts)
            completion_tokens = estimate_tokens(raw)
            budget.record(project.workspace_id, prompt_tokens + completion_tokens)
            recorded = True

            baseline = _baseline_from(raw)
            if not baseline:
                settled = True
                _fail(prompt_tokens, completion_tokens)
                payload = {"error": "the model returned an empty baseline", "retryable": True}
                yield f"event: error\ndata: {json.dumps(payload)}\n\n"
                return

            truncated = finish[0] == "length"
            stored = repo.upsert_repo_analysis(
                analysis.model_copy(update={"baseline": baseline, "status": "baseline_ready"})
            )
            repo.update_generation_run(
                run.id,
                status="truncated" if truncated else "succeeded",
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
            )
            settled = True
            done = json.loads(_out(project, stored, stale=False).model_dump_json())
            # Same meaning as on a stage generation: the baseline is stored and
            # usable, but the model stopped at its output limit.
            done["truncated"] = truncated
            yield f"event: done\ndata: {json.dumps(done)}\n\n"
        finally:
            # Reached without a final status when the client disconnected
            # mid-stream (the generator is closed at its current `yield`) or a
            # write above raised. The tokens were spent either way, and an
            # analysis left at `snapshot_ready` with a run left `running`
            # would misreport what happened.
            if not settled:
                completion_tokens = estimate_tokens("".join(parts))
                try:
                    if not recorded:
                        budget.record(project.workspace_id, prompt_tokens + completion_tokens)
                    _fail(prompt_tokens, completion_tokens)
                except Exception:  # noqa: BLE001 - never mask the original exit
                    logger.exception("settling baseline run for project %s failed", project.id)

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/projects/{project_id}/repo-analysis", response_model=RepoAnalysisOut)
async def get_repository_analysis(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RepoAnalysisOut:
    """Member-readable, like a stage document: seeing what the plan was
    written against is not privileged. The snapshot's excerpts are the
    exception — verbatim file contents, redacted but still the customer's
    source — and reach admins only; a member gets `excerpts: []`.

    `stale` costs one branch-head read, and only while the analysis still
    matters (before `repo_created`). Push webhooks cannot answer it — the
    repository's hook is registered at `repo_created`, after the analysis has
    stopped mattering — and a failed read reports `null`, not `false`. An
    answer is reused for `_STALE_TTL_SECONDS` per project and analysed commit.
    """
    project = require_project(repo, project_id, user)
    analysis = repo.get_repo_analysis(project_id)
    is_admin = repo.get_membership(project.workspace_id, user.id) == Role.admin
    if analysis is None or not requires_repo_analysis(project):
        return _out(project, analysis, include_excerpts=is_admin)

    cached = _stale_cache.get(project_id)
    now = time.monotonic()
    if cached is not None and cached[1] == analysis.commit_sha:
        if now - cached[0] < _STALE_TTL_SECONDS:
            return _out(project, analysis, stale=cached[2], include_excerpts=is_admin)

    stale: bool | None = None
    try:
        token, full_name = _github_access(request, repo, project)
        head = await request.app.state.github_client.get_branch_head(
            token, full_name, project.repo_default_branch or "main"
        )
        stale = head != analysis.commit_sha
        # Only an answer is cached; "could not check" is asked again next time.
        _stale_cache[project_id] = (now, analysis.commit_sha, stale)
    except (HTTPException, GithubWriteError) as exc:
        logger.info("staleness check for project %s skipped: %s", project_id, exc)
    return _out(project, analysis, stale=stale, include_excerpts=is_admin)


@router.patch("/projects/{project_id}/repo-analysis", response_model=RepoAnalysisOut)
def update_repository_baseline(
    project_id: str,
    body: RepoAnalysisBaselineUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> RepoAnalysisOut:
    """Hand-edit the baseline, the way a stage document is edited
    (app/api/stage_documents.py). An edit to a non-empty text is a
    `baseline_ready` analysis — the Tech Lead's word is as good as the
    model's, and a baseline written entirely by hand is a legitimate way to
    open the gate on a workspace out of budget. Clearing it closes the gate
    again."""
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    analysis = repo.get_repo_analysis(project_id)
    if analysis is None:
        raise HTTPException(status_code=409, detail="repo_analysis_not_found")
    baseline = body.baseline.strip()
    stored = repo.upsert_repo_analysis(
        analysis.model_copy(
            update={
                "baseline": baseline,
                "status": "baseline_ready" if baseline else "snapshot_ready",
            }
        )
    )
    return _out(project, stored)
