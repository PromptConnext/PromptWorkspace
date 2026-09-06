"""Freezing a build's task set (ADR 0023 decision 4)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.deployments.attribution import freeze_build_tasks
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import (
    Artifact,
    ArtifactKind,
    Deployment,
    DeploymentConfig,
    GraphUpsertRequest,
    Task,
)

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


def _setup(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    repository.update_project_deployment_config(
        project["id"], DeploymentConfig(template_id="static-r2")
    )
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", "main")
    repository.update_workspace(
        ws["id"],
        integration_config={
            "github": {"owner": "acme", "secret_ref": client.app.state.secret_store.encrypt("ghp")}
        },
    )
    repository.upsert_graph(
        project["id"],
        GraphUpsertRequest(
            tasks=[
                Task(id="t1", project_id=project["id"], title="Retry", feature_tag="T1"),
                Task(id="t2", project_id=project["id"], title="Cache", feature_tag="T2"),
                Task(id="t3", project_id=project["id"], title="Login", feature_tag="T3"),
            ],
            artifacts=[
                Artifact(
                    id="a1",
                    project_id=project["id"],
                    task_id="t1",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c1",
                ),
                Artifact(
                    id="a2",
                    project_id=project["id"],
                    task_id="t2",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c2",
                ),
                Artifact(
                    id="a3",
                    project_id=project["id"],
                    task_id="t3",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c3",
                ),
            ],
        ),
        source="pz",
    )
    return repository.get_project(project["id"])


def _deploy(repository, project, *, key: str, state: str, sha: str | None) -> Deployment:
    return repository.upsert_deployment(
        Deployment(
            workspace_id=project.workspace_id,
            project_id=project.id,
            provider="platform-r2",
            template_id="static-r2",
            external_key=key,
            state=state,
            commit_sha=sha,
        )
    )


@pytest.mark.anyio
async def test_the_first_build_takes_every_commit_it_can_see(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c2")] = ["c1", "c2"]
    row = _deploy(repository, project, key="1", state="live", sha="c2")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t1", "t2"]
    assert repository.list_deployment_tasks(row.id) == ["t1", "t2"]


@pytest.mark.anyio
async def test_a_later_build_takes_only_what_is_new_since_the_last_good_one(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    first = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, first)

    client.app.state.github_client.comparisons[(REPO, "c1", "c3")] = ["c2", "c3"]
    second = _deploy(repository, project, key="2", state="live", sha="c3")
    assert await freeze_build_tasks(client.app, repository, project, second) == ["t2", "t3"]
    # The earlier build's record is untouched — that is the point of freezing.
    assert repository.list_deployment_tasks(first.id) == ["t1"]


@pytest.mark.anyio
async def test_a_failed_build_still_names_what_was_in_it(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="failed", sha="c1")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t1"]


@pytest.mark.anyio
async def test_an_unreachable_git_host_falls_back_to_the_head_commit(client):
    project = _setup(client)
    repository = client.app.state.repository
    # Nothing registered: the fake answers with no commits at all.
    row = _deploy(repository, project, key="1", state="live", sha="c2")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t2"]


@pytest.mark.anyio
async def test_a_build_with_no_commit_freezes_nothing(client):
    project = _setup(client)
    repository = client.app.state.repository
    row = _deploy(repository, project, key="1", state="live", sha=None)
    assert await freeze_build_tasks(client.app, repository, project, row) == []
