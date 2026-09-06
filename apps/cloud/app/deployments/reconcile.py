"""Reconciling deployments the webhook never finished (ADR 0023 decision 7).

An outbound poll, not an inbound callback — ADR 0021's decision 3 forbids a
second inbound channel, and this does not open one. It exists because the
webhook is best-effort by construction: one lost delivery leaves a business
user watching a preview that says "building" forever, and five delivery kinds
with twenty-minute mobile builds cannot absorb that the way one static
template could.

Deliberately conservative. A deployment GitHub still reports as in-flight is
left alone however old it is; only a terminal answer, or GitHub not knowing
the deployment at all, closes a row out.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from app.deployments.registry import PREVIEW_ENVIRONMENT, get_template
from app.deployments.state import DEPLOY_STATE_BY_GITHUB, refresh_deployment_state
from app.integrations.github_auth import resolve_token
from app.models.schemas import Deployment, utcnow

logger = logging.getLogger("promptconnext.deploy")


def _repo_full_name(repo_url: str | None) -> str | None:
    if not repo_url:
        return None
    parts = [p for p in repo_url.rstrip("/").split("/") if p]
    return f"{parts[-2]}/{parts[-1]}" if len(parts) >= 2 else None


async def _reconcile_one(app, repo, row: Deployment) -> bool:
    project = repo.get_project(row.project_id)
    if project is None:
        return False
    full_name = _repo_full_name(project.repo_url)
    if full_name is None:
        return False
    resolved = resolve_token(app, repo.get_workspace(project.workspace_id))
    if resolved is None:
        return False
    token, _config = resolved
    client = app.state.github_client

    state: str | None = None
    url = row.url
    run_url = row.run_url
    error_code = None
    error_message = None

    try:
        if row.external_key.startswith("run-"):
            run = await client.get_workflow_run(token, full_name, row.external_key[4:])
            if run is None:
                state = "failed"
                error_code = "deploy_abandoned"
            elif run.get("status") == "completed":
                conclusion = run.get("conclusion")
                run_url = run.get("html_url") or run_url
                if conclusion in ("success", "skipped"):
                    # A successful run reports itself as a deployment; nothing
                    # to close out here.
                    return False
                state = "failed"
                error_code = "build_failed"
                error_message = f"workflow run {conclusion}"
        else:
            status = await client.get_deployment(token, full_name, row.external_key)
            if status is None:
                state = "failed"
                error_code = "deploy_abandoned"
            else:
                if str(status.get("environment") or PREVIEW_ENVIRONMENT) != PREVIEW_ENVIRONMENT:
                    return False
                mapped = DEPLOY_STATE_BY_GITHUB.get(str(status.get("state") or ""))
                if mapped is None or mapped not in ("live", "failed", "inactive"):
                    # Still moving. Age is not evidence of failure.
                    return False
                state = mapped
                run_url = status.get("log_url") or status.get("target_url") or run_url
                if mapped == "failed":
                    error_code = "deploy_failed"
                    error_message = status.get("description")
                else:
                    # The URL is re-validated by the same rule the webhook path
                    # uses; see app/api/github.py::_trusted_environment_url.
                    from app.api.github import _trusted_environment_url

                    template = (
                        get_template(project.deployment_config.template_id)
                        if project.deployment_config
                        else None
                    )
                    url = (
                        _trusted_environment_url(
                            app, project, template, status.get("environment_url")
                        )
                        or url
                    )
    except Exception:  # noqa: BLE001 - a sweep must never crash the app
        logger.warning("reconciling deployment %s failed", row.id, exc_info=True)
        return False

    if state is None:
        return False

    if error_code == "deploy_abandoned":
        error_message = "The build stopped reporting and could not be found."

    repo.upsert_deployment(
        row.model_copy(
            update={
                "state": state,
                "url": url if state != "failed" else None,
                "run_url": run_url,
                "error_code": error_code,
                "error_message": error_message,
            }
        )
    )
    project = repo.get_project(row.project_id)
    refresh_deployment_state(repo, project)

    if state in ("live", "failed"):
        # Same freeze the webhook path performs, for the same reason: a build
        # closed out here is just as terminal as one GitHub told us about.
        from app.deployments.attribution import freeze_build_tasks

        latest = repo.get_latest_deployment(row.project_id)
        if latest is not None and latest.external_key == row.external_key:
            await freeze_build_tasks(app, repo, project, latest)

    logger.info("reconciled deployment %s to %s", row.id, state)
    return True


async def reconcile_once(app) -> int:
    """One pass. Returns how many rows were closed out."""
    settings = app.state.settings
    repo = app.state.repository
    cutoff = utcnow() - timedelta(seconds=settings.deployment_stale_after_seconds)
    rows = repo.list_stale_deployments(cutoff)
    closed = 0
    for row in rows:
        if await _reconcile_one(app, repo, row):
            closed += 1
    return closed


async def reconcile_loop(app, settings) -> None:
    if settings.deployment_reconcile_interval_seconds <= 0:
        return
    while True:
        await asyncio.sleep(settings.deployment_reconcile_interval_seconds)
        try:
            closed = await reconcile_once(app)
            if closed:
                logger.info("Deployment reconciliation closed out %s deploy(s)", closed)
        except Exception:  # noqa: BLE001 - the sweep must never crash the app
            logger.exception("Deployment reconciliation pass failed")
