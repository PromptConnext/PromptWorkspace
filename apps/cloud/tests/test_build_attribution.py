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
    Role,
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
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", 1, "main")
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
    # Frozen, not merely empty: there is nothing more to learn about a build
    # that carries no commit, so it is a finished answer.
    assert repository.get_latest_deployment(project.id).attribution_state == "frozen"


# --------------------------------------------------------------------------- #
# Freezing once (plan 0024 M2)
# --------------------------------------------------------------------------- #


@pytest.mark.anyio
async def test_freezing_records_the_state_and_the_time(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    assert row.attribution_state == "uncomputed"

    await freeze_build_tasks(client.app, repository, project, row)

    stored = repository.get_latest_deployment(project.id)
    assert stored.attribution_state == "frozen"
    assert stored.attributed_at is not None


@pytest.mark.anyio
async def test_a_redelivery_after_the_graph_changed_does_not_rewrite_history(client):
    """The defect, exactly. GitHub redelivers a terminal webhook; the graph
    has moved on; the stored set must not."""
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t1"]

    # Somebody attaches another commit in this build's range to another task.
    repository.upsert_graph(
        project.id,
        GraphUpsertRequest(
            artifacts=[
                Artifact(
                    id="a9",
                    project_id=project.id,
                    task_id="t2",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c1",
                )
            ]
        ),
        source="pz",
    )

    # The redelivery re-reads the row, as every real call site does.
    again = repository.get_latest_deployment(project.id)
    client.app.state.github_client.call_log.clear()
    assert await freeze_build_tasks(client.app, repository, project, again) == ["t1"]
    assert repository.list_deployment_tasks(row.id) == ["t1"]

    # And it cost nothing: the early return sits before the round trip, so a
    # redelivery cannot even observe the changed graph, let alone store it.
    assert client.app.state.github_client.call_log == []


@pytest.mark.anyio
async def test_a_build_that_closed_nothing_is_frozen_not_uncomputed(client):
    """Empty and unknown are different facts, and this is the empty one."""
    project = _setup(client)
    repository = client.app.state.repository
    # A commit range holding no attributable commit.
    client.app.state.github_client.commit_lists[(REPO, "c9")] = ["c9"]
    row = _deploy(repository, project, key="1", state="live", sha="c9")

    assert await freeze_build_tasks(client.app, repository, project, row) == []
    assert repository.get_latest_deployment(project.id).attribution_state == "frozen"


@pytest.mark.anyio
async def test_the_reconciliation_sweep_does_not_overwrite_a_frozen_set(client):
    from app.deployments.reconcile import reconcile_once

    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, row)

    repository.upsert_graph(
        project.id,
        GraphUpsertRequest(
            artifacts=[
                Artifact(
                    id="a9",
                    project_id=project.id,
                    task_id="t3",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c1",
                )
            ]
        ),
        source="pz",
    )
    await reconcile_once(client.app)
    assert repository.list_deployment_tasks(row.id) == ["t1"]


@pytest.mark.anyio
async def test_the_webhook_path_freezes_once_across_two_deliveries(client):
    """End to end through the real webhook handler, not the resolver alone —
    the upsert on the second delivery is the back door that would otherwise
    reset the flag before the freeze ran."""
    from app.api.github import _handle_deployment_status

    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]

    payload = {
        "deployment": {"id": 55, "sha": "c1", "ref": "main", "environment": "preview"},
        "deployment_status": {
            "state": "success",
            "environment": "preview",
            "log_url": "https://github.test/run/1",
            "description": "",
        },
    }
    await _handle_deployment_status(client.app, repository, project, payload)
    row = repository.get_latest_deployment(project.id)
    assert repository.list_deployment_tasks(row.id) == ["t1"]
    assert row.attribution_state == "frozen"

    repository.upsert_graph(
        project.id,
        GraphUpsertRequest(
            artifacts=[
                Artifact(
                    id="a9",
                    project_id=project.id,
                    task_id="t2",
                    kind=ArtifactKind.code,
                    uri="u",
                    commit_sha="c1",
                )
            ]
        ),
        source="pz",
    )
    await _handle_deployment_status(client.app, repository, project, payload)
    assert repository.list_deployment_tasks(row.id) == ["t1"]


# --------------------------------------------------------------------------- #
# The deliberate recompute path
# --------------------------------------------------------------------------- #


def _reattribute(client, project_id: str, deployment_id: str, headers: dict):
    return client.post(
        f"/projects/{project_id}/deployments/{deployment_id}/reattribute", headers=headers
    )


@pytest.mark.anyio
async def test_reattribute_widens_a_set_frozen_without_a_working_token(client):
    """The one case the escape hatch exists for: the commit-range lookup was
    swallowed, the set fell back to the head commit alone, and no automatic
    path will ever widen it."""
    project = _setup(client)
    repository = client.app.state.repository
    # Nothing registered on the fake: the range resolves to the head alone.
    row = _deploy(repository, project, key="1", state="live", sha="c2")
    assert await freeze_build_tasks(client.app, repository, project, row) == ["t2"]

    # The admin fixes the token; now the whole range is visible.
    client.app.state.github_client.commit_lists[(REPO, "c2")] = ["c1", "c2"]

    res = _reattribute(client, project.id, row.id, ALICE)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["previous_task_ids"] == ["t2"]
    assert body["task_ids"] == ["t1", "t2"]
    assert body["attribution_state"] == "frozen"
    assert body["changed"] is True
    assert repository.list_deployment_tasks(row.id) == ["t1", "t2"]


@pytest.mark.anyio
async def test_reattribute_is_admin_only(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, row)

    # A plain member of the same workspace. Reading which tasks are in a build
    # is membership-gated; rewriting the record of what shipped is not.
    repository.add_member(project.workspace_id, "bob", Role.member)
    res = _reattribute(client, project.id, row.id, {"X-User-Id": "bob"})
    assert res.status_code == 403
    assert repository.list_deployment_tasks(row.id) == ["t1"]


@pytest.mark.anyio
async def test_reattribute_refuses_a_non_member_entirely(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, row)

    res = _reattribute(client, project.id, row.id, {"X-User-Id": "mallory"})
    assert res.status_code in (403, 404)


@pytest.mark.anyio
async def test_reattribute_404s_for_an_unknown_deployment(client):
    project = _setup(client)
    assert _reattribute(client, project.id, "no-such-row", ALICE).status_code == 404


@pytest.mark.anyio
async def test_reattribute_reports_when_nothing_changed(client):
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, row)

    body = _reattribute(client, project.id, row.id, ALICE).json()
    assert body["changed"] is False
    assert body["task_ids"] == ["t1"]
    assert repository.get_latest_deployment(project.id).attribution_state == "frozen"


@pytest.mark.anyio
async def test_a_redelivery_after_a_recompute_is_frozen_again(client):
    """The flag must not be left cleared behind the endpoint: a webhook
    arriving after a correction has to be a no-op like any other."""
    project = _setup(client)
    repository = client.app.state.repository
    client.app.state.github_client.commit_lists[(REPO, "c1")] = ["c1"]
    row = _deploy(repository, project, key="1", state="live", sha="c1")
    await freeze_build_tasks(client.app, repository, project, row)
    _reattribute(client, project.id, row.id, ALICE)

    again = repository.get_latest_deployment(project.id)
    assert again.attribution_state == "frozen"
    client.app.state.github_client.call_log.clear()
    await freeze_build_tasks(client.app, repository, project, again)
    assert client.app.state.github_client.call_log == []
