"""Project lifecycle: planning -> pending_tech_review -> tech_review ->
repo_created (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md,
"Project Lifecycle & Cloud<->Desktop Coordination"). This plan only
implements the default status and the business-user "Send to Tech Lead"
transition — later sub-projects own the rest of the state machine.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.db.repository import Repository
from app.dependencies import get_repository
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import DeploymentConfig

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


def test_create_repository_seed_403_reports_token_scope_not_a_transient_failure():
    """A 403/404 writing into the repo GitHub just created means the token
    cannot see it — a fine-grained PAT scoped to selected repositories. That
    is a 400 the admin must act on, not a 502 inviting an endless retry."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        fake.fail_on_write_path = "AGENTS.md"
        fake.write_failure_status = 403

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 400
        assert res.json()["detail"] == "github_repo_not_in_token_scope"

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


def test_create_repository_retry_reports_token_scope_when_the_repo_is_unreadable():
    """The adopt path's other outcome: the name is taken by a repo the token
    cannot read (403). That used to escape as an unhandled httpx error — an
    opaque 500 — instead of the actionable 400 the seeding step already
    returns for the same underlying cause."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        fake.existing_repos["acme/rocket-ship"] = {
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
        }
        fake.get_repo_failure_status = 403

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 400
        assert res.json()["detail"] == "github_repo_not_in_token_scope"

        project = client.app.state.repository.get_project(pid)
        assert project.lifecycle_status == "tech_review"
        assert project.repo_url is None


def test_create_repository_retry_is_502_when_github_is_unwell():
    """A 5xx from the same lookup is transient — 502, so the panel keeps
    inviting a retry rather than sending the admin to fix their token."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        fake.existing_repos["acme/rocket-ship"] = {
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
        }
        fake.get_repo_failure_status = 500

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 502
        assert res.json()["detail"] == "github_repo_create_failed"


class _CallerScopedRepository:
    """Stands in for what an authenticated request actually gets: a Supabase
    client carrying the caller's JWT, i.e. the `authenticated` role. Migration
    0020 revokes pz_repo_webhooks from that role, so this write is the one
    operation such a client can never perform."""

    def __init__(self, inner: Repository) -> None:
        self._inner = inner
        self.blocked = 0

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    def upsert_repo_webhook(self, webhook):
        self.blocked += 1
        raise RuntimeError("permission denied for table pz_repo_webhooks")


def test_create_repository_writes_the_webhook_binding_with_the_service_key():
    """The binding must be written through app.state.repository (service key),
    not the caller-scoped repository — which is revoked on that table and
    answers `permission denied`, previously a bare 500 *after* the repo had
    already been created and seeded."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        ws, pid = _project_in_tech_review(client)

        service_repo = client.app.state.repository
        scoped = _CallerScopedRepository(service_repo)
        client.app.dependency_overrides[get_repository] = lambda: scoped
        try:
            res = client.post(
                f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
            )
        finally:
            client.app.dependency_overrides.pop(get_repository, None)

        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
        assert scoped.blocked == 0, "the binding went through the caller-scoped repository"

        binding = service_repo.get_repo_webhook("acme/rocket-ship")
        assert binding is not None
        assert binding.project_id == pid
        # Ciphertext only — the generated secret is never stored in the clear.
        registered_secret = fake.webhooks[0]["secret"]
        assert binding.secret_ref != registered_secret
        assert client.app.state.secret_store.decrypt(binding.secret_ref) == registered_secret


def test_create_repository_survives_a_failed_webhook_binding_write():
    """Bookkeeping is best-effort by design: a repo that exists and is fully
    seeded must not be stranded in tech_review because a follow-up row could
    not be written. The cost is indexing, and it is logged."""
    with _client() as client:
        _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        ws, pid = _project_in_tech_review(client)

        def _explode(_webhook):
            raise RuntimeError("permission denied for table pz_repo_webhooks")

        client.app.state.repository.upsert_repo_webhook = _explode

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)

        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
        assert res.json()["repo_url"] == "https://github.com/acme/rocket-ship"


def test_create_repository_forbidden_for_non_member():
    with _client() as client:
        _wire_github(client)
        ws, pid = _project_in_tech_review(client)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=BOB)
        assert res.status_code == 403


# --------------------------------------------------------------------------- #
# Deployment templates at repo creation (ADR 0021)
# --------------------------------------------------------------------------- #
def _with_template(client: TestClient, project_id: str, template_id: str = "static-r2") -> None:
    client.app.state.repository.update_project_deployment_config(
        project_id, DeploymentConfig(template_id=template_id)
    )
    # What a real deployment must also configure: the public base URL the
    # platform-hosted template's preview is served from. Without it there is
    # no URL to hand the workflow, and repo creation refuses.
    client.app.state.settings.deploy_r2_public_base_url = "https://preview.test"


def _create_repo(client: TestClient, project_id: str):
    return client.post(
        f"/projects/{project_id}/lifecycle/create-repository", json={}, headers=ALICE
    )


def test_seeding_is_a_single_commit_not_one_per_file():
    """The change that makes a 40-file scaffold survivable: ADR 0017's
    per-file loop would be N commits and N round-trips, with a partial-seed
    window proportional to scaffold size."""
    with _client() as client:
        fake = _wire_github(client)
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        assert _create_repo(client, pid).status_code == 200
        assert len(fake.commits) == 1
        paths = fake.commits[0]["paths"]
        assert "AGENTS.md" in paths
        assert ".github/workflows/deploy.yml" in paths
        assert "docs/deployment.md" in paths
        assert "site/index.html" in paths


def test_project_without_a_template_seeds_exactly_what_it_did_before():
    """Backward compatibility, asserted rather than assumed: a project that
    never chose a template must produce the same file set as before this
    feature existed."""
    with _client() as client:
        fake = _wire_github(client)
        _ws, pid = _project_in_tech_review(client)

        assert _create_repo(client, pid).status_code == 200
        paths = set(fake.commits[0]["paths"])
        assert paths == {"AGENTS.md", "README.md", "docs/conventions.md"}
        assert not fake.secrets
        assert not fake.variables


def test_secrets_and_webhook_are_written_before_the_seed_commit():
    """Ordering is the contract. The seed commit fires `on: push`, so a
    workflow starting before its secrets exist fails for nothing — and a
    delivery arriving before the webhook binding exists is dropped as an
    unknown repo, losing the first deploy's URL."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://api.test"
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        assert _create_repo(client, pid).status_code == 200
        commit_at = fake.call_log.index("commit:acme/rocket-ship")
        assert max(i for i, e in enumerate(fake.call_log) if e.startswith("secret:")) < commit_at
        assert fake.call_log.index("webhook:acme/rocket-ship") < commit_at


def test_deploy_credentials_reach_the_repo_as_secrets_and_variables():
    with _client() as client:
        fake = _wire_github(client)
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        assert _create_repo(client, pid).status_code == 200
        repo_name = "acme/rocket-ship"
        assert fake.secrets[(repo_name, "PZ_R2_ACCESS_KEY_ID")]
        assert fake.secrets[(repo_name, "PZ_R2_SECRET_ACCESS_KEY")]
        assert fake.variables[(repo_name, "PZ_PROJECT_ID")] == pid
        assert fake.variables[(repo_name, "PZ_ENVIRONMENT")] == "preview"


def test_deployment_state_starts_at_awaiting_first_deploy():
    """Not "building": the commit has landed but GitHub has not told us a run
    started, and every state this feature shows is one it was told about."""
    with _client() as client:
        _wire_github(client)
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        body = _create_repo(client, pid).json()
        assert body["deployment_state"]["state"] == "awaiting_first_deploy"
        assert body["deployment_state"]["template_id"] == "static-r2"


def test_secret_write_403_reports_the_new_token_scope_and_leaves_lifecycle_untouched():
    """Secrets: write is a permission this feature added, which no existing
    workspace PAT carries and no introspection endpoint can reveal earlier."""
    with _client() as client:
        fake = _wire_github(client)
        fake.fail_on_secret_write = "PZ_R2_ACCESS_KEY_ID"
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        res = _create_repo(client, pid)
        assert res.status_code == 400
        assert res.json()["detail"] == "github_secrets_not_in_token_scope"
        assert not fake.commits, "nothing may be committed once provisioning failed"
        project = client.get(f"/projects/{pid}", headers=ALICE).json()
        assert project["lifecycle_status"] == "tech_review"


def test_missing_platform_credential_fails_before_any_repo_is_created():
    """Fail fast, step 3: a provider that cannot supply a credential must be
    caught before GitHub is touched at all."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.deploy_r2_api_token = ""
        client.app.state.settings.deploy_r2_allow_shared_key = False
        client.app.state.r2_client = None  # would explode if it were reached
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        res = _create_repo(client, pid)
        assert res.status_code == 400
        assert res.json()["detail"] == "deployment_provider_not_configured"
        assert not fake.created_repos
        project = client.get(f"/projects/{pid}", headers=ALICE).json()
        assert project["lifecycle_status"] == "tech_review"
