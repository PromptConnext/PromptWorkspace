"""The reconciliation sweep (ADR 0023 decision 7).

An outbound poll, not an inbound callback: a lost webhook delivery must not
leave a business user staring at "building" forever.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.deployments.reconcile import reconcile_once
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import Deployment, DeploymentConfig, RepoWebhook, utcnow

ALICE = {"X-User-Id": "alice"}
REPO = "acme/rocket"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _project_with_stuck_deploy(client: TestClient, *, age_minutes: int, external_key: str = "9"):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_deployment_config(
        project["id"], DeploymentConfig(template_id="static-r2")
    )
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", 1, "main")
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt("whsec"),
        )
    )
    # A workspace GitHub PAT must resolve, or the sweep has no way to ask.
    repository.update_workspace(
        ws["id"],
        integration_config={
            "github": {"owner": "acme", "secret_ref": client.app.state.secret_store.encrypt("ghp")}
        },
    )
    stuck = repository.upsert_deployment(
        Deployment(
            workspace_id=ws["id"],
            project_id=project["id"],
            provider="platform-r2",
            template_id="static-r2",
            external_key=external_key,
            state="building",
        )
    )
    aged = stuck.model_copy(update={"updated_at": utcnow() - timedelta(minutes=age_minutes)})
    repository._deployments[project["id"]][external_key] = aged
    return project["id"]


@pytest.mark.anyio
async def test_a_stuck_deploy_is_closed_out_from_the_deployments_api(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60)
    client.app.state.github_client.deployment_states[(REPO, "9")] = {
        "state": "success",
        "environment": "preview",
        "environment_url": "https://preview.test/previews/x/index.html",
        "log_url": "https://github.com/acme/rocket/actions/runs/1",
    }
    assert await reconcile_once(client.app) == 1
    rows = client.app.state.repository.list_deployments(project_id)
    assert rows[0].state == "live"


@pytest.mark.anyio
async def test_a_recent_deploy_is_left_alone(client):
    _project_with_stuck_deploy(client, age_minutes=1)
    assert await reconcile_once(client.app) == 0


@pytest.mark.anyio
async def test_a_deploy_github_has_forgotten_is_marked_failed(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60)
    # Nothing registered for (REPO, "9") — GitHub answers 404.
    assert await reconcile_once(client.app) == 1
    rows = client.app.state.repository.list_deployments(project_id)
    assert rows[0].state == "failed"
    assert rows[0].error_code == "deploy_abandoned"


@pytest.mark.anyio
async def test_a_workflow_run_key_is_reconciled_against_the_runs_api(client):
    project_id = _project_with_stuck_deploy(client, age_minutes=60, external_key="run-42")
    client.app.state.github_client.workflow_runs[(REPO, "42")] = {
        "status": "completed",
        "conclusion": "failure",
        "html_url": "https://github.com/acme/rocket/actions/runs/42",
    }
    assert await reconcile_once(client.app) == 1
    assert client.app.state.repository.list_deployments(project_id)[0].state == "failed"
