"""Project lifecycle: planning -> pending_tech_review -> tech_review ->
repo_created (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md,
"Project Lifecycle & Cloud<->Desktop Coordination"). This plan only
implements the default status and the business-user "Send to Tech Lead"
transition — later sub-projects own the rest of the state machine.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _client() -> TestClient:
    app = create_app()
    return TestClient(app)


def _wire_github(client: TestClient) -> FakeGithubClient:
    fake = FakeGithubClient()
    client.app.state.github_client = fake
    return fake


def _project_in_tech_review(client: TestClient, *, configure_github: bool = True):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket Ship", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]
    repo = client.app.state.repository
    repo.update_project_lifecycle_status(pid, "tech_review")
    if configure_github:
        repo.update_workspace(
            ws["id"],
            integration_config={
                "github": {
                    "auth_kind": "pat",
                    "owner": "acme",
                    "owner_type": "Organization",
                    "secret_ref": client.app.state.secret_store.encrypt("github_pat_test"),
                }
            },
        )
    return ws, pid


def test_new_project_defaults_to_planning():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        assert project["lifecycle_status"] == "planning"
        assert project["repo_url"] is None
        assert project["repo_default_branch"] is None


def test_update_project_lifecycle_status_persists():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()

        repo = client.app.state.repository
        updated = repo.update_project_lifecycle_status(project["id"], "pending_tech_review")
        assert updated.lifecycle_status == "pending_tech_review"

        refetched = repo.get_project(project["id"])
        assert refetched.lifecycle_status == "pending_tech_review"


def test_submit_for_review_requires_a_specification():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()

        res = client.post(
            f"/projects/{project['id']}/lifecycle/submit-for-review", headers=ALICE
        )
        assert res.status_code == 400
        assert res.json()["detail"] == "planning_incomplete"


def test_submit_for_review_transitions_planning_to_pending_tech_review():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]

        # Directly seed a minimal graph — this test is about the lifecycle
        # transition, not generation (see test_generation.py for that).
        # A requirement alone is the whole gate: the transition now fires when
        # a Tech Lead opens the Plan step, i.e. *before* the plan and tasks
        # they are about to write exist.
        repo = client.app.state.repository
        from app.models.schemas import GraphUpsertRequest, Requirement

        requirement = Requirement(project_id=pid, title="R")
        repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")

        res = client.post(f"/projects/{pid}/lifecycle/submit-for-review", headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "pending_tech_review"


def test_submit_for_review_rejects_when_not_in_planning():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]
        client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

        res = client.post(f"/projects/{pid}/lifecycle/submit-for-review", headers=ALICE)
        assert res.status_code == 409
        assert res.json()["detail"] == "not_in_planning"


# --------------------------------------------------------------------------- #
# start-tech-review
# --------------------------------------------------------------------------- #
def test_start_tech_review_transitions_pending_to_tech_review():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]
        client.app.state.repository.update_project_lifecycle_status(pid, "pending_tech_review")

        res = client.post(f"/projects/{pid}/lifecycle/start-tech-review", headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "tech_review"


def test_start_tech_review_is_idempotent_once_in_tech_review():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]
        client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

        res = client.post(f"/projects/{pid}/lifecycle/start-tech-review", headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "tech_review"


def test_start_tech_review_rejects_when_not_pending():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]  # still "planning"

        res = client.post(f"/projects/{pid}/lifecycle/start-tech-review", headers=ALICE)
        assert res.status_code == 409
        assert res.json()["detail"] == "not_pending_tech_review"


# --------------------------------------------------------------------------- #
# create-repository
# --------------------------------------------------------------------------- #
def test_create_repository_happy_path():
    with _client() as client:
        _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        repo = client.app.state.repository
        repo.upsert_stage_document(pid, ws["id"], "constitution", "# Rules\n\nBe kind.", "alice")

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["lifecycle_status"] == "repo_created"
        assert body["repo_url"] == "https://github.com/acme/rocket-ship"
        assert body["repo_default_branch"] == "main"

        fake = client.app.state.github_client
        assert ("acme/rocket-ship", "AGENTS.md") in fake.written_files
        assert "Be kind." in fake.written_files[("acme/rocket-ship", "AGENTS.md")]


def test_create_repository_rejects_when_not_in_tech_review():
    with _client() as client:
        _wire_github(client)
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]  # still "planning"

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 409
        assert res.json()["detail"] == "not_in_tech_review"


def test_create_repository_400_when_github_not_configured_and_lifecycle_unchanged():
    with _client() as client:
        _wire_github(client)
        ws, pid = _project_in_tech_review(client, configure_github=False)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 400
        assert res.json()["detail"] == "github_not_configured"

        project = client.app.state.repository.get_project(pid)
        assert project.lifecycle_status == "tech_review"
        assert project.repo_url is None


def test_create_repository_seed_failure_is_502_and_leaves_lifecycle_untouched():
    """The decisive regression test: a seed-write failure must not advance
    the lifecycle nor persist a repo_url, so a retry can safely re-adopt."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        fake.fail_on_write_path = "AGENTS.md"

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 502
        assert res.json()["detail"] == "github_seed_failed"

        project = client.app.state.repository.get_project(pid)
        assert project.lifecycle_status == "tech_review"
        assert project.repo_url is None


def test_create_repository_retry_adopts_existing_repo_without_duplicate_create():
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)

        # Simulate a prior partial attempt: the repo already exists on
        # GitHub (e.g. from a crash after create but before seeding).
        fake.existing_repos["acme/rocket-ship"] = {
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
        }

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
        assert res.json()["repo_url"] == "https://github.com/acme/rocket-ship"
        # No duplicate create — create_org_repo raised RepoAlreadyExistsError
        # and the retry path adopted via get_repo instead.
        assert fake.created_repos == []


def test_create_repository_forbidden_for_non_member():
    with _client() as client:
        _wire_github(client)
        ws, pid = _project_in_tech_review(client)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=BOB)
        assert res.status_code == 403
