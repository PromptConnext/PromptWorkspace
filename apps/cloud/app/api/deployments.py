"""Deployment template endpoints (ADR 0021).

  GET   /deployment-templates                          list the built-in templates
  PATCH /projects/{id}/deployment-config               admin — select a template
  GET   /projects/{id}/deployment                      member — status + live URL
  POST  /projects/{id}/deployment/repair-webhook       admin — widen hook events

Two authorization postures on purpose, and the split is the feature:

  Writing the configuration is `require_admin` — the Tech Lead's decision.
  ("Tech Lead" is the workspace admin role; there is no separate role in the
  schema. See app/api/_guards.py:34-39.) This is *unlike* policy scope, which
  any member may set, because a deployment template decides what gets
  committed to the repository and which credential is provisioned into it.

  Reading the status is `require_project` — plain membership. Business-user
  discovery of the running application is the entire point of the feature, so
  gating the read would defeat it.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.api._guards import require_admin, require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.registry import BUILTIN_TEMPLATES, get_template, template_files
from app.integrations.deploy_providers import get_provider
from app.integrations.github import GithubWriteError, ensure_hook_events
from app.integrations.github_auth import resolve_token
from app.models.schemas import (
    Deployment,
    DeploymentConfig,
    DeploymentConfigUpdate,
    Project,
)

logger = logging.getLogger("promptconnext.deployments")
router = APIRouter(tags=["deployments"])

# Terminal states: a deploy in any other state is still moving, and is what
# the web app's poller counts to decide whether to keep polling.
_TERMINAL_STATES = frozenset({"live", "failed", "inactive"})


class DeploymentTemplateOut(BaseModel):
    id: str
    name: str
    description: str
    stack: str
    # embedded_url | external_url | api_console | artifact_download | store_build
    delivery_kind: str
    provider: str
    provider_label: str
    # True when the platform owns the credential, so the picker can say "no
    # account needed" instead of sending the Tech Lead to workspace settings.
    provider_is_platform_owned: bool
    embeddable: bool
    required_secrets: list[str]
    required_vars: list[str]
    # Repo-relative paths this template seeds, and the workflow's full text.
    # Shipped inline on the list so the picker can preview what a template
    # will commit without a second round-trip per template — the same lesson
    # app/api/policies.py records for policy bodies.
    scaffold_paths: list[str]
    workflow_preview: str


class DeploymentOut(BaseModel):
    id: str
    state: str
    url: str | None
    commit_sha: str | None
    ref: str | None
    run_url: str | None
    frame_policy: str | None
    created_at: str
    updated_at: str


class DeploymentErrorOut(BaseModel):
    code: str
    message: str
    run_url: str | None
    at: str


class DeploymentStatusOut(BaseModel):
    """GET /projects/{id}/deployment.

    Every field is server-measured. `pending` is the poll driver — poll while
    it is above zero, stop at zero — exactly as IndexStatusOut's
    `pending_jobs` already works for reindexing.

    There is no progress percentage here and there must never be one. A
    deploy's duration is unknown to this service, and an animated estimate is
    the failure app/api/assistant.py's index status and the web app's
    ReindexPanel both deliberately avoid.

    `url` is LAST KNOWN GOOD while `state` is current: a failed deploy must
    not blank a preview that is still serving.
    """

    template_id: str | None
    template_name: str | None
    provider: str | None
    embeddable: bool
    state: str
    url: str | None
    health_path: str
    pending: int
    last_deploy: DeploymentOut | None
    recent: list[DeploymentOut]
    last_error: DeploymentErrorOut | None


def _deployment_out(row: Deployment) -> DeploymentOut:
    return DeploymentOut(
        id=row.id,
        state=row.state,
        url=row.url,
        commit_sha=row.commit_sha,
        ref=row.ref,
        run_url=row.run_url,
        frame_policy=row.frame_policy,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


@router.get("/deployment-templates", response_model=list[DeploymentTemplateOut])
def list_deployment_templates(
    # Accepted but unused today, mirroring app/api/policies.py: the deferred
    # org-owned template merge lands in this same endpoint with no web
    # contract change — `ws:`-prefixed rows appended to the built-ins.
    workspace_id: str | None = None,
    user: User = Depends(get_current_user),
) -> list[DeploymentTemplateOut]:
    out: list[DeploymentTemplateOut] = []
    for template in BUILTIN_TEMPLATES:
        files = template_files(template.id)
        workflow = next(
            (content for path, content, _ in files if path == template.workflow_path), ""
        )
        provider = get_provider(template.provider)
        out.append(
            DeploymentTemplateOut(
                id=template.id,
                name=template.name,
                description=template.description,
                stack=template.stack,
                delivery_kind=template.delivery_kind,
                provider=template.provider,
                provider_label=provider.label if provider else template.provider,
                provider_is_platform_owned=bool(provider and provider.platform_owned),
                embeddable=template.embeddable,
                required_secrets=[s.name for s in template.required_secrets],
                required_vars=[v.name for v in template.required_vars],
                scaffold_paths=sorted(path for path, _, _ in files),
                workflow_preview=workflow,
            )
        )
    return out


@router.patch("/projects/{project_id}/deployment-config", response_model=Project)
def update_deployment_config(
    project_id: str,
    body: DeploymentConfigUpdate,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Select the project's deployment template.

    Frozen at `repo_created` for the same reason policy scope is: the
    repository already carries the previous template's scaffold, and letting
    the selection drift from what was committed would leave a project whose
    recorded plan and actual pipeline disagree. Changing it after the repo
    exists is a re-provision operation, not an edit.
    """
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    if project.lifecycle_status == "repo_created":
        raise HTTPException(status_code=409, detail="project_frozen")
    if get_template(body.template_id) is None:
        raise HTTPException(status_code=422, detail="unknown_deployment_template")
    return repo.update_project_deployment_config(
        project_id, DeploymentConfig(template_id=body.template_id)
    )


@router.get("/projects/{project_id}/deployment", response_model=DeploymentStatusOut)
def get_deployment_status(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DeploymentStatusOut:
    """Membership only — no admin gate. A business user finding the running
    application without a development environment is the reason this feature
    exists."""
    project = require_project(repo, project_id, user)
    config = project.deployment_config
    template = get_template(config.template_id) if config else None
    state = project.deployment_state

    rows = repo.list_deployments(project_id, limit=10)
    last_error = next(
        (r for r in rows if r.state == "failed" and r.error_code),
        None,
    )

    return DeploymentStatusOut(
        template_id=config.template_id if config else None,
        template_name=template.name if template else None,
        provider=template.provider if template else None,
        # The registry's design-time claim, narrowed by what the deployed app
        # actually answered when the server probed its headers. "unknown" is
        # left as embeddable: the web app's postMessage handshake settles it,
        # and refusing to embed on a maybe would be the wrong default.
        embeddable=bool(template and template.embeddable)
        and (rows[0].frame_policy != "deny" if rows else True),
        state=state.state if state else "not_configured",
        url=state.url if state else None,
        health_path=template.health_path if template else "/",
        pending=sum(1 for r in rows if r.state not in _TERMINAL_STATES),
        last_deploy=_deployment_out(rows[0]) if rows else None,
        recent=[_deployment_out(r) for r in rows],
        last_error=(
            DeploymentErrorOut(
                code=last_error.error_code or "deploy_failed",
                message=last_error.error_message or "The deploy did not complete.",
                run_url=last_error.run_url,
                at=last_error.updated_at.isoformat(),
            )
            if last_error
            else None
        ),
    )


@router.post("/projects/{project_id}/deployment/repair-webhook")
async def repair_webhook(
    project_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> dict:
    """Widen this project's repo hook to the current event list.

    The one endpoint in this feature that is *allowed* while `repo_created`,
    because it is the only migration path for repositories created before ADR
    0021: those hooks carry `push` and `pull_request` only, so no deploy they
    run will ever be visible here. Re-running repo creation cannot fix it —
    that route returns early for a project already at `repo_created`, and its
    registration call swallows GitHub's "already exists" as success.

    Idempotent: a hook already carrying every event is left untouched.
    """
    project = require_project(repo, project_id, user)
    require_admin(repo, project.workspace_id, user)
    if not project.repo_url:
        raise HTTPException(status_code=409, detail="repo_not_created")

    resolved = resolve_token(request.app, repo.get_workspace(project.workspace_id))
    if resolved is None:
        raise HTTPException(status_code=400, detail="github_not_configured")
    token, _config = resolved

    public_api_url = request.app.state.settings.public_api_url
    if not public_api_url:
        raise HTTPException(status_code=400, detail="public_api_url_not_configured")

    full_name = _repo_full_name(project.repo_url)
    if full_name is None:
        raise HTTPException(status_code=409, detail="repo_url_unrecognized")

    try:
        repaired = await ensure_hook_events(
            request.app.state.github_client,
            token,
            full_name,
            f"{public_api_url.rstrip('/')}/api/webhooks/github",
        )
    except GithubWriteError as exc:
        logger.warning("repairing the hook for %s failed: %s", full_name, exc)
        if getattr(exc, "status_code", None) in (401, 403, 404):
            raise HTTPException(
                status_code=400, detail="github_repo_not_in_token_scope"
            ) from exc
        raise HTTPException(status_code=502, detail="github_hook_repair_failed") from exc

    return {"repaired": repaired}


def _repo_full_name(repo_url: str) -> str | None:
    """`https://github.com/acme/widget` -> `acme/widget`.

    Derived rather than stored: `repo_url` is what repo creation persisted, and
    adding a second column that could disagree with it would be one more thing
    to keep in sync for no gain.
    """
    parts = [p for p in repo_url.rstrip("/").split("/") if p]
    if len(parts) < 2:
        return None
    return f"{parts[-2]}/{parts[-1]}"
