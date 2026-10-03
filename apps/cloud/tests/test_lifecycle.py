"""Project lifecycle: planning -> pending_tech_review -> tech_review ->
repo_created (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md,
"Project Lifecycle & Cloud<->Desktop Coordination"). This plan only
implements the default status and the business-user "Send to Tech Lead"
transition — later sub-projects own the rest of the state machine.
"""

from __future__ import annotations

import asyncio
import threading

from fastapi.testclient import TestClient

from app.db.repository import Repository
from app.dependencies import get_repository
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import DeploymentConfig, RepoWebhook, Role

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
        # plan 0016: the numeric id GitHub assigned at creation is persisted —
        # the identity a later collision check verifies against, not just
        # repo_url/full_name.
        assert body["repo_id"] == fake.created_repos[0]["id"]


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
    """The crash window plan 0016 names: repo_id was never persisted (step 8
    never ran), so the only signal available is the description this project
    would have written verbatim at creation — present here, which is what
    makes this a genuine retry rather than the collision M2 refuses."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)

        # Simulate a prior partial attempt: the repo already exists on
        # GitHub (e.g. from a crash after create but before seeding), with
        # the description this project's own create_org_repo call would have
        # sent.
        fake.existing_repos["acme/rocket-ship"] = {
            "id": 4242,
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
            "description": f"PromptWorkspace-managed repository for project {pid}",
        }

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
        assert res.json()["repo_url"] == "https://github.com/acme/rocket-ship"
        assert res.json()["repo_id"] == 4242
        # No duplicate create — create_org_repo raised RepoAlreadyExistsError
        # and the retry path adopted via get_repo instead.
        assert fake.created_repos == []


def test_create_repository_retry_after_repo_id_persisted_uses_the_numeric_id():
    """The other crash window: repo_id WAS persisted on an earlier successful
    retry (e.g. secrets/webhook/commit failed afterward), so the numeric id
    is authoritative — even if the repository were renamed and its
    description no longer matched, which this test proves by making the
    description wrong on purpose."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        client.app.state.repository.update_project_repo(
            pid, "https://github.com/acme/rocket-ship", 4242, "main"
        )
        fake.existing_repos["acme/rocket-ship"] = {
            "id": 4242,
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
            "description": "renamed since — description no longer matches",
        }

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "repo_created"
        assert fake.created_repos == []


def test_create_repository_refuses_to_adopt_an_unrelated_repo_with_the_same_name():
    """The finding plan 0016 exists for: a name collision with a repository
    this project never created must not silently adopt it and write secrets,
    a webhook and a seed commit into someone else's repository."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        fake.existing_repos["acme/rocket-ship"] = {
            "id": 999,
            "full_name": "acme/rocket-ship",
            "html_url": "https://github.com/acme/rocket-ship",
            "default_branch": "main",
            "description": "Alice's personal fork",
        }

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert res.status_code == 409, res.text
        assert res.json()["detail"] == "repo_name_collision"

        project = client.app.state.repository.get_project(pid)
        assert project.lifecycle_status == "tech_review"
        assert project.repo_url is None
        assert project.repo_id is None
        # Nothing downstream of the identity check should have fired against
        # a repository that failed it.
        assert fake.call_log == ["get_repo:acme/rocket-ship"]


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
    0020 revokes pw_repo_webhooks from that role, so this write is the one
    operation such a client can never perform."""

    def __init__(self, inner: Repository) -> None:
        self._inner = inner
        self.blocked = 0

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    def create_repo_webhook_if_absent(self, webhook):
        self.blocked += 1
        raise RuntimeError("permission denied for table pw_repo_webhooks")


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
        assert binding.registration_state == "confirmed"


def test_create_repository_retry_reuses_the_persisted_webhook_secret():
    """A retry after the hook but before the seed commit must keep GitHub's
    remote secret and the local binding aligned. FakeGithubClient models
    GitHub's duplicate rejection by keeping the first hook and secret.
    """
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        _ws, pid = _project_in_tech_review(client)

        fake.fail_on_commit = True
        first = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert first.status_code == 502, first.text

        repo_name = "acme/rocket-ship"
        original_secret = fake.webhooks[0]["secret"]
        first_binding = client.app.state.repository.get_repo_webhook(repo_name)
        assert first_binding is not None
        assert client.app.state.secret_store.decrypt(first_binding.secret_ref) == original_secret

        fake.fail_on_commit = False
        retry = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert retry.status_code == 200, retry.text
        assert len(fake.webhooks) == 1
        assert fake.webhooks[0]["secret"] == original_secret

        binding = client.app.state.repository.get_repo_webhook(repo_name)
        assert binding is not None
        assert client.app.state.secret_store.decrypt(binding.secret_ref) == original_secret


def test_create_repository_requires_repair_for_a_legacy_remote_hook_without_binding():
    """A duplicate remote hook with an unknown secret cannot be adopted.

    Keeping the repository identity lets the future deliberate repair rotate
    the remote hook, but the provisional local secret must be removed first.
    """
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        _ws, pid = _project_in_tech_review(client)
        repo_name = "acme/rocket-ship"
        legacy_secret = "legacy-remote-secret"
        fake.webhooks.append(
            {
                "repo": repo_name,
                "url": "https://cloud.example.com/api/webhooks/github",
                "secret": legacy_secret,
                "events": ["push", "pull_request"],
            }
        )

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)

        assert res.status_code == 409, res.text
        assert res.json()["detail"] == "webhook_secret_repair_required"
        project = client.app.state.repository.get_project(pid)
        assert project.lifecycle_status == "tech_review"
        assert project.repo_url == "https://github.com/acme/rocket-ship"
        assert project.repo_id == fake.created_repos[0]["id"]
        assert client.app.state.repository.get_repo_webhook(repo_name) is None
        assert fake.webhooks == [
            {
                "repo": repo_name,
                "url": "https://cloud.example.com/api/webhooks/github",
                "secret": legacy_secret,
                "events": ["push", "pull_request"],
            }
        ]
        assert fake.commits == []


def test_create_repository_keeps_an_unreadable_existing_binding_for_repair():
    """A corrupt binding cannot be silently replaced with a new secret."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        ws, pid = _project_in_tech_review(client)
        repo_name = "acme/rocket-ship"
        corrupt = RepoWebhook(
            repo_full_name=repo_name,
            project_id=pid,
            workspace_id=ws["id"],
            secret_ref="not-a-secret-store-ciphertext",
        )
        client.app.state.repository.upsert_repo_webhook(corrupt)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)

        assert res.status_code == 409, res.text
        assert res.json()["detail"] == "webhook_secret_repair_required"
        assert client.app.state.repository.get_repo_webhook(repo_name) == corrupt
        assert fake.webhooks == []
        assert client.app.state.repository.get_project(pid).lifecycle_status == "tech_review"


class _BlockingWebhookFake(FakeGithubClient):
    """Holds the first registration open to expose a second request's view."""

    def __init__(self) -> None:
        super().__init__()
        self.registration_started = threading.Event()
        self.continue_registration = threading.Event()

    async def create_repo_webhook(self, token, repo, callback_url, secret):
        self.registration_started.set()
        assert await asyncio.to_thread(self.continue_registration.wait, 2)
        return await super().create_repo_webhook(token, repo, callback_url, secret)


def test_overlapping_legacy_hook_registration_never_adopts_a_provisional_secret():
    """Only the reservation creator may inspect the duplicate remote hook.

    The concurrent request sees `pending` and returns an in-progress response
    without making its own GitHub call or accepting the first request's secret.
    """
    with _client() as client:
        fake = _BlockingWebhookFake()
        client.app.state.github_client = fake
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        _ws, pid = _project_in_tech_review(client)
        fake.webhooks.append(
            {
                "repo": "acme/rocket-ship",
                "url": "https://cloud.example.com/api/webhooks/github",
                "secret": "legacy-secret",
                "events": ["push"],
            }
        )

        first_result = {}

        def first_request() -> None:
            first_result["response"] = client.post(
                f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
            )

        first = threading.Thread(target=first_request)
        first.start()
        assert fake.registration_started.wait(timeout=2)

        second = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE)
        assert second.status_code == 409, second.text
        assert second.json()["detail"] == "webhook_registration_in_progress"
        assert fake.call_log.count("webhook:acme/rocket-ship") == 0

        fake.continue_registration.set()
        first.join(timeout=2)
        assert not first.is_alive()
        first_response = first_result["response"]
        assert first_response.status_code == 409, first_response.text
        assert first_response.json()["detail"] == "webhook_secret_repair_required"
        assert fake.call_log.count("webhook:acme/rocket-ship") == 1
        assert client.app.state.repository.get_repo_webhook("acme/rocket-ship") is None


def test_create_repository_retries_after_webhook_registration_failure():
    """A failed registration keeps its reserved secret and tech-review
    lifecycle so the next request can safely finish provisioning."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        _ws, pid = _project_in_tech_review(client)
        fake.fail_on_webhook = True

        failed = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert failed.status_code == 502, failed.text
        assert failed.json()["detail"] == "github_webhook_failed"
        assert fake.webhooks == []
        assert client.app.state.repository.get_project(pid).lifecycle_status == "tech_review"

        repo_name = "acme/rocket-ship"
        first_binding = client.app.state.repository.get_repo_webhook(repo_name)
        assert first_binding is not None
        reserved_secret = client.app.state.secret_store.decrypt(first_binding.secret_ref)

        fake.fail_on_webhook = False
        retry = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["lifecycle_status"] == "repo_created"
        assert len(fake.webhooks) == 1
        assert fake.webhooks[0]["secret"] == reserved_secret

        binding = client.app.state.repository.get_repo_webhook(repo_name)
        assert binding is not None
        assert client.app.state.secret_store.decrypt(binding.secret_ref) == reserved_secret


def test_create_repository_retries_when_webhook_binding_cannot_be_persisted():
    """Never tell the caller the repo is ready when GitHub could be signing
    with a secret that the cloud failed to store. The failed request leaves a
    re-adoptable repository and does not register a remote hook; a later retry
    can reserve the binding and finish safely."""
    with _client() as client:
        fake = _wire_github(client)
        client.app.state.settings.public_api_url = "https://cloud.example.com"
        ws, pid = _project_in_tech_review(client)

        service_repo = client.app.state.repository
        original = service_repo.create_repo_webhook_if_absent

        def _explode(_webhook):
            raise RuntimeError("permission denied for table pw_repo_webhooks")

        service_repo.create_repo_webhook_if_absent = _explode

        failed = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert failed.status_code == 502
        assert failed.json()["detail"] == "webhook_binding_failed"
        assert fake.webhooks == []
        assert service_repo.get_project(pid).lifecycle_status == "tech_review"

        service_repo.create_repo_webhook_if_absent = original
        retry = client.post(
            f"/projects/{pid}/lifecycle/create-repository", json={}, headers=ALICE
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["lifecycle_status"] == "repo_created"
        assert len(fake.webhooks) == 1


def test_webhook_binding_reservation_keeps_the_first_secret():
    """The in-memory implementation follows the same first-writer-wins
    contract as Supabase's INSERT ... ON CONFLICT DO NOTHING."""
    with _client() as client:
        repo = client.app.state.repository
        first = RepoWebhook(
            repo_full_name="acme/retry-race",
            project_id="project-a",
            workspace_id="workspace-a",
            secret_ref="first-secret-ref",
        )
        second = RepoWebhook(
            repo_full_name="acme/retry-race",
            project_id="project-a",
            workspace_id="workspace-a",
            secret_ref="second-secret-ref",
        )

        stored, created = repo.create_repo_webhook_if_absent(first)
        assert (stored, created) == (first, True)
        stored, created = repo.create_repo_webhook_if_absent(second)
        assert (stored, created) == (first, False)
        assert repo.get_repo_webhook("acme/retry-race") == first


def test_create_repository_forbidden_for_non_member():
    with _client() as client:
        _wire_github(client)
        ws, pid = _project_in_tech_review(client)

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=BOB)
        assert res.status_code == 403


def test_create_repository_forbidden_for_a_non_admin_member():
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        client.app.state.repository.add_member(ws["id"], "bob", Role.member, invited_by="alice")

        res = client.post(f"/projects/{pid}/lifecycle/create-repository", json={}, headers=BOB)
        assert res.status_code == 403
        assert fake.commits == []


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
        assert fake.secrets[(repo_name, "PROMPTWORKSPACE_R2_ACCESS_KEY_ID")]
        assert fake.secrets[(repo_name, "PROMPTWORKSPACE_R2_SECRET_ACCESS_KEY")]
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_PROJECT_ID")] == pid
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_ENVIRONMENT")] == "preview"


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
        fake.fail_on_secret_write = "PROMPTWORKSPACE_R2_ACCESS_KEY_ID"
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid)

        res = _create_repo(client, pid)
        assert res.status_code == 400
        assert res.json()["detail"] == "github_secrets_not_in_token_scope"
        assert not fake.commits, "nothing may be committed once provisioning failed"
        project = client.get(f"/projects/{pid}", headers=ALICE).json()
        assert project["lifecycle_status"] == "tech_review"


def _connect_vercel(client: TestClient, workspace_id: str) -> None:
    """The workspace half of a Vercel connection: the token and the team it
    can reach. Deliberately no project id — that is the project's (ADR 0025)."""
    ws = client.app.state.repository.get_workspace(workspace_id)
    merged = dict(ws.integration_config or {})
    merged["vercel"] = {
        "org_id": "team_1",
        "secret_ref": client.app.state.secret_store.encrypt("vercel-token"),
        "connected_by": "alice",
    }
    client.app.state.repository.update_workspace(workspace_id, integration_config=merged)


def test_a_project_without_its_provider_project_id_fails_before_any_repo_is_created():
    """ADR 0025. The workspace credential is connected and valid; what is
    missing is the Vercel project THIS project deploys to, which is fixed on
    the project's template rather than by reconnecting the workspace."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        _connect_vercel(client, ws["id"])
        client.app.state.repository.update_project_deployment_config(
            pid, DeploymentConfig(template_id="next-vercel")
        )

        res = _create_repo(client, pid)
        assert res.status_code == 400
        assert res.json()["detail"] == "deployment_project_values_missing"
        assert not fake.created_repos


def test_the_projects_own_provider_id_reaches_the_pipeline_it_seeds():
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        _connect_vercel(client, ws["id"])
        client.app.state.repository.update_project_deployment_config(
            pid,
            DeploymentConfig(
                template_id="next-vercel", provider_values={"project_id": "prj_mine"}
            ),
        )

        assert _create_repo(client, pid).status_code == 200, "provisioning should succeed"
        repo_name = "acme/rocket-ship"
        # The whole point: the variable the workflow reads carries THIS
        # project's Vercel project, while the team still comes from the
        # workspace credential every project shares.
        assert fake.variables[(repo_name, "VERCEL_PROJECT_ID")] == "prj_mine"
        assert fake.variables[(repo_name, "VERCEL_ORG_ID")] == "team_1"
        assert fake.secrets[(repo_name, "VERCEL_TOKEN")] == "vercel-token"


def _connect_docker_host(client: TestClient, workspace_id: str) -> None:
    """The workspace half of a Docker host connection: the key, the address,
    the user and the host key. No app name, port or URL — those are the
    project's (ADR 0025), because one host runs many projects."""
    ws = client.app.state.repository.get_workspace(workspace_id)
    merged = dict(ws.integration_config or {})
    merged["ssh-docker"] = {
        "host": "box.example.com",
        "ssh_user": "deploy",
        "known_hosts": "box.example.com ssh-ed25519 AAAA",
        "secret_ref": client.app.state.secret_store.encrypt("PRIVATE KEY"),
        "connected_by": "alice",
    }
    client.app.state.repository.update_workspace(workspace_id, integration_config=merged)


def test_a_docker_compose_project_seeds_the_runtime_its_plan_describes():
    """ADR 0026. The plan decides which hand-written scaffold is committed;
    the Tech Lead decides where it runs."""
    with _client() as client:
        fake = _wire_github(client)
        ws, pid = _project_in_tech_review(client)
        client.app.state.repository.upsert_stage_document(
            pid, ws["id"], "plan", "# Architecture\n\nA FastAPI service in Python.", "alice"
        )
        _connect_docker_host(client, ws["id"])
        client.app.state.repository.update_project_deployment_config(
            pid,
            DeploymentConfig(
                template_id="docker-compose",
                provider_values={
                    "app_slug": "rocket",
                    "host_port": "8081",
                    "public_url": "https://rocket.example.com",
                },
            ),
        )

        assert _create_repo(client, pid).status_code == 200, "provisioning should succeed"
        repo_name = "acme/rocket-ship"

        # This project's placement on the shared host, not the workspace's.
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_APP_SLUG")] == "rocket"
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_HOST_PORT")] == "8081"
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_SSH_HOST")] == "box.example.com"
        assert fake.secrets[(repo_name, "PROMPTWORKSPACE_SSH_KEY")] == "PRIVATE KEY"

        # Nobody mints the URL of a customer's own server, so the one the Tech
        # Lead named is what the workflow health-checks and what the Preview
        # tab opens — the same value on both sides.
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_PREVIEW_URL")] == "https://rocket.example.com"
        state = client.app.state.repository.get_project(pid).deployment_state
        assert state.url == "https://rocket.example.com"
        assert state.state == "awaiting_first_deploy"

        paths = set(fake.commits[0]["paths"])
        assert {"Dockerfile", "compose.yaml", "main.py"} <= paths
        assert "server.js" not in paths


def test_a_github_pages_project_provisions_with_no_credential_at_all():
    """The third credential posture (ADR 0023's amendment): nothing is
    connected, nothing is sealed into the repository, and the preview URL is
    derived from the repository the cloud just created."""
    with _client() as client:
        fake = _wire_github(client)
        _ws, pid = _project_in_tech_review(client)
        _with_template(client, pid, "github-pages")

        assert _create_repo(client, pid).status_code == 200, "provisioning should succeed"
        repo_name = "acme/rocket-ship"

        # No secret exists to write: the deploy runs on the token GitHub gives
        # the workflow. Only the two bookkeeping variables are set.
        assert not [key for key in fake.secrets if key[0] == repo_name]
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_PROJECT_ID")] == pid
        assert fake.variables[(repo_name, "PROMPTWORKSPACE_ENVIRONMENT")] == "preview"

        # Resolved after creation, because before it there was no repository
        # to derive it from.
        state = client.app.state.repository.get_project(pid).deployment_state
        assert state.url == "https://acme.github.io/rocket-ship/"
        assert state.state == "awaiting_first_deploy"

        paths = set(fake.commits[0]["paths"])
        assert {"site/index.html", ".github/workflows/deploy.yml"} <= paths


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
