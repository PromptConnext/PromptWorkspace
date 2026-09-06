"""The project's denormalized current deployment view.

Lives here rather than in the webhook router because ADR 0023's reconciliation
sweep writes deployments too, and two copies of this rule would drift.
"""

from __future__ import annotations

from app.db.repository import Repository
from app.deployments.registry import get_template
from app.models.schemas import DeploymentState

# GitHub's deployment states, mapped onto the five this feature shows. Both
# `error` and `failure` are failures to a business user; `inactive` means a
# newer deploy superseded this one.
DEPLOY_STATE_BY_GITHUB = {
    "queued": "queued",
    "pending": "queued",
    "in_progress": "building",
    "success": "live",
    "failure": "failed",
    "error": "failed",
    "inactive": "inactive",
}


def refresh_deployment_state(repo: Repository, project) -> None:
    """Recompute the project's denormalized current view from its rows.

    `url` is deliberately last-known-good while `state` is current: a failed
    deploy must not blank a preview that is still serving. The business
    user's link keeps working while the Tech Lead fixes the build, which is
    the whole point of showing them a preview in the first place.
    """
    rows = repo.list_deployments(project.id, limit=10)
    if not rows:
        return
    latest = rows[0]
    last_good_url = next((r.url for r in rows if r.state == "live" and r.url), None)
    config = project.deployment_config
    template = get_template(config.template_id) if config else None
    repo.update_project_deployment_state(
        project.id,
        DeploymentState(
            template_id=config.template_id if config else None,
            provider=template.provider if template else None,
            state=latest.state,
            url=last_good_url,
            commit_sha=latest.commit_sha,
            run_url=latest.run_url,
        ),
    )
