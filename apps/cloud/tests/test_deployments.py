"""Deployment status: the inbound webhook contract and the read endpoint
(ADR 0021).

The signed-delivery helpers mirror tests/test_github_ingest.py — same
per-repo HMAC secret, same routing-then-verification order.
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.deployments.registry import WORKFLOW_PATH
from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.models.schemas import DeploymentConfig, GraphUpsertRequest, RepoWebhook, Role, Task

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
WEBHOOK_SECRET = "whsec_test"
REPO = "acme/rocket"
TEMPLATE = "static-r2"
PREVIEW_BASE = "https://preview.test"


def preview_url(project_id: str) -> str:
    """What the cloud provisions for a platform-hosted template. The webhook
    handler pins reported URLs to this prefix, so a test that made one up
    would be testing the rejection path by accident."""
    return f"{PREVIEW_BASE}/previews/{project_id}/index.html"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _project(client: TestClient, *, with_template: bool = True, member: str | None = None):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    repository = client.app.state.repository
    # What a real deployment must configure for the platform-hosted template.
    client.app.state.settings.deploy_r2_public_base_url = PREVIEW_BASE
    if with_template:
        repository.update_project_deployment_config(
            project["id"], DeploymentConfig(template_id=TEMPLATE)
        )
    if member:
        # Directly, as tests/test_policy_scope.py does — the HTTP path is an
        # invitation flow, and this is about authorization, not invitations.
        repository.add_member(ws["id"], member, Role.member, invited_by="alice")
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt(WEBHOOK_SECRET),
        )
    )
    return ws, project["id"]


def _post(client: TestClient, event: str, payload: dict, secret: str = WEBHOOK_SECRET):
    body = json.dumps(payload).encode()
    return client.post(
        "/api/webhooks/github",
        content=body,
        headers={
            "content-type": "application/json",
            "x-github-event": event,
            "x-hub-signature-256": "sha256="
            + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(),
        },
    )


def _deployment_status(
    project_id: str,
    *,
    state: str,
    deployment_id: int = 77,
    url: str | None = "",
    environment: str = "preview",
) -> dict:
    # "" means "the URL the cloud actually provisioned"; None means "no URL".
    if url == "":
        url = preview_url(project_id)
    return {
        "repository": {"full_name": REPO},
        "deployment": {
            "id": deployment_id,
            "environment": environment,
            "sha": "abc123",
            "ref": "main",
        },
        "deployment_status": {
            "state": state,
            "environment": environment,
            "environment_url": url,
            "log_url": "https://github.test/run/1",
            "description": "Preview published" if state == "success" else "boom",
        },
    }


def _workflow_run(*, conclusion: str, run_id: int = 900, path: str = WORKFLOW_PATH) -> dict:
    return {
        "repository": {"full_name": REPO},
        "workflow_run": {
            "id": run_id,
            "path": path,
            "status": "completed",
            "conclusion": conclusion,
            "head_sha": "def456",
            "head_branch": "main",
            "html_url": "https://github.test/run/2",
        },
    }


def _status(client: TestClient, project_id: str, headers=ALICE) -> dict:
    res = client.get(f"/projects/{project_id}/deployment", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def test_successful_deployment_records_a_row_and_goes_live(client):
    _ws, pid = _project(client)
    res = _post(client, "deployment_status", _deployment_status(pid, state="success"))
    assert res.status_code == 200

    body = _status(client, pid)
    assert body["state"] == "live"
    assert body["url"] == preview_url(pid)
    assert body["template_id"] == TEMPLATE
    assert body["pending"] == 0
    assert len(body["recent"]) == 1


def test_repeat_delivery_for_one_deploy_updates_in_place(client):
    """A single deploy emits in_progress then success. Without the
    (project_id, external_key) key each would append, and the history a
    business user reads would be twice as long as the truth."""
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="in_progress", url=None))
    mid = _status(client, pid)
    assert mid["state"] == "building"
    assert mid["pending"] == 1

    _post(client, "deployment_status", _deployment_status(pid, state="success"))
    end = _status(client, pid)
    assert end["state"] == "live"
    assert end["pending"] == 0
    assert len(end["recent"]) == 1, "the same deploy must not become two rows"


def test_a_second_deploy_is_a_second_row(client):
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="success", deployment_id=1))
    _post(client, "deployment_status", _deployment_status(pid, state="success", deployment_id=2))
    assert len(_status(client, pid)["recent"]) == 2


def test_failed_build_keeps_the_last_known_good_url(client):
    """The whole reason `url` and `state` are separate fields: a business
    user's link must keep working while the Tech Lead fixes the build."""
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="success"))
    _post(client, "workflow_run", _workflow_run(conclusion="failure"))

    body = _status(client, pid)
    assert body["state"] == "failed"
    assert body["url"] == preview_url(pid)
    assert body["last_error"]["code"] == "build_failed"
    assert body["last_error"]["run_url"] == "https://github.test/run/2"


def test_successful_workflow_run_is_ignored(client):
    """It would fight the deployment row for the project's current state, and
    it carries no URL to contribute."""
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="success"))
    _post(client, "workflow_run", _workflow_run(conclusion="success"))
    body = _status(client, pid)
    assert body["state"] == "live"
    assert len(body["recent"]) == 1


def test_workflow_run_from_another_workflow_is_ignored(client):
    """A repo's own test or lint workflow failing is not a failed preview."""
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="success"))
    _post(
        client,
        "workflow_run",
        _workflow_run(conclusion="failure", path=".github/workflows/ci.yml"),
    )
    assert _status(client, pid)["state"] == "live"


def test_non_preview_environment_is_ignored(client):
    """A repository that grows its own production workflow must not start
    reporting production as the business user's preview."""
    _ws, pid = _project(client)
    res = _post(
        client,
        "deployment_status",
        _deployment_status(pid, state="success", environment="production"),
    )
    assert res.status_code == 200
    assert _status(client, pid)["state"] == "not_configured"


def test_unsigned_delivery_is_rejected(client):
    _ws, pid = _project(client)
    res = _post(
        client, "deployment_status", _deployment_status(pid, state="success"), secret="wrong"
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_signature"


def test_unknown_repo_is_acked_not_matched(client):
    _ws, pid = _project(client)
    payload = _deployment_status(pid, state="success")
    payload["repository"]["full_name"] = "someone/else"
    res = _post(client, "deployment_status", payload)
    assert res.status_code == 200
    assert res.json() == {"received": True, "matched": False}


def test_status_is_readable_by_a_plain_member(client):
    """Business-user discovery is the point of the feature — gating this read
    behind admin would defeat it."""
    _ws, pid = _project(client, member="bob")
    _post(client, "deployment_status", _deployment_status(pid, state="success"))
    assert _status(client, pid, headers=BOB)["url"] == preview_url(pid)


def test_status_is_not_readable_by_a_non_member(client):
    _ws, pid = _project(client)
    res = client.get(f"/projects/{pid}/deployment", headers=BOB)
    assert res.status_code == 403


def test_status_for_a_project_with_no_template(client):
    _ws, pid = _project(client, with_template=False)
    body = _status(client, pid)
    assert body["state"] == "not_configured"
    assert body["template_id"] is None
    assert body["url"] is None
    assert body["recent"] == []


def test_deny_framing_narrows_embeddable(client, monkeypatch):
    """The registry's design-time claim is only a claim; what the deployed app
    actually answers wins."""
    import app.api.github as github_api

    async def deny(_url: str) -> str:
        return "deny"

    monkeypatch.setattr(github_api, "_probe_frame_policy", deny)
    _ws, pid = _project(client)
    _post(client, "deployment_status", _deployment_status(pid, state="success"))

    body = _status(client, pid)
    assert body["last_deploy"]["frame_policy"] == "deny"
    assert body["embeddable"] is False


# --------------------------------------------------------------------------- #
# Configuration endpoint
# --------------------------------------------------------------------------- #
def test_admin_can_select_a_template(client):
    ws, pid = _project(client, with_template=False)
    res = client.patch(
        f"/projects/{pid}/deployment-config", json={"template_id": TEMPLATE}, headers=ALICE
    )
    assert res.status_code == 200, res.text
    assert res.json()["deployment_config"]["template_id"] == TEMPLATE


def test_plain_member_cannot_select_a_template(client):
    """Unlike policy scope, which any member may set: this decides what gets
    committed to the repo and which credential is provisioned into it."""
    ws, pid = _project(client, with_template=False, member="bob")
    res = client.patch(
        f"/projects/{pid}/deployment-config", json={"template_id": TEMPLATE}, headers=BOB
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"


def test_unknown_template_is_rejected(client):
    ws, pid = _project(client, with_template=False)
    res = client.patch(
        f"/projects/{pid}/deployment-config", json={"template_id": "nope"}, headers=ALICE
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "unknown_deployment_template"


def test_a_project_names_its_own_provider_side_project(client):
    """ADR 0025. Two projects in one workspace must be able to deploy to two
    different Vercel projects; before this the identifier lived on the shared
    workspace credential and the second project overwrote the first."""
    ws, pid = _project(client, with_template=False)
    res = client.patch(
        f"/projects/{pid}/deployment-config",
        json={"template_id": "next-vercel", "provider_values": {"project_id": " prj_a "}},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["deployment_config"]["provider_values"] == {"project_id": "prj_a"}


def test_only_project_scoped_keys_are_stored(client):
    """These values are merged over the resolved credential when the pipeline
    is seeded, so an unfiltered dict would let a project admin overwrite the
    token that gets written into a repository secret."""
    ws, pid = _project(client, with_template=False)
    res = client.patch(
        f"/projects/{pid}/deployment-config",
        json={
            "template_id": "next-vercel",
            "provider_values": {
                "project_id": "prj_a",
                "token": "stolen",
                "org_id": "not-yours",
                "secret_ref": "x",
            },
        },
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert res.json()["deployment_config"]["provider_values"] == {"project_id": "prj_a"}


def test_the_picker_is_told_which_identifiers_a_template_needs_per_project(client):
    templates = {t["id"]: t for t in client.get("/deployment-templates", headers=ALICE).json()}
    assert [f["name"] for f in templates["next-vercel"]["provider_project_fields"]] == [
        "project_id"
    ]
    assert [f["name"] for f in templates["docker-compose"]["provider_project_fields"]] == [
        "app_slug",
        "host_port",
        "public_url",
    ]
    # The platform-owned template asks for nothing: there is no provider-side
    # project, only a prefix in a bucket the platform already minted.
    assert templates["static-r2"]["provider_project_fields"] == []


def test_template_is_frozen_once_the_repo_exists(client):
    ws, pid = _project(client, with_template=True)
    client.app.state.repository.update_project_lifecycle_status(pid, "repo_created")
    res = client.patch(
        f"/projects/{pid}/deployment-config", json={"template_id": TEMPLATE}, headers=ALICE
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "project_frozen"


# --------------------------------------------------------------------------- #
# Webhook repair — the migration path for repos created before ADR 0021
# --------------------------------------------------------------------------- #
def _repo_created(
    client: TestClient, ws_id: str, pid: str, *, events: list[str]
) -> FakeGithubClient:
    repository = client.app.state.repository
    repository.update_project_repo(pid, f"https://github.com/{REPO}", 1, "main")
    repository.update_workspace(
        ws_id,
        integration_config={
            "github": {
                "auth_kind": "pat",
                "owner": "acme",
                "owner_type": "Organization",
                "secret_ref": client.app.state.secret_store.encrypt("github_pat_test"),
            }
        },
    )
    fake: FakeGithubClient = client.app.state.github_client
    fake.webhooks.append(
        {"repo": REPO, "url": "https://api.test/api/webhooks/github", "secret": "s"}
    )
    fake.hooks_events[REPO] = list(events)
    client.app.state.settings.public_api_url = "https://api.test"
    return fake


def test_repair_widens_a_legacy_hook(client):
    ws, pid = _project(client)
    fake = _repo_created(client, ws["id"], pid, events=["push", "pull_request"])

    res = client.post(f"/projects/{pid}/deployment/repair-webhook", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json() == {"repaired": True}
    assert "deployment_status" in fake.hooks_events[REPO]
    assert "workflow_run" in fake.hooks_events[REPO]


def test_repair_is_idempotent(client):
    ws, pid = _project(client)
    fake = _repo_created(
        client,
        ws["id"],
        pid,
        events=["push", "pull_request", "workflow_run", "deployment_status"],
    )
    client.post(f"/projects/{pid}/deployment/repair-webhook", headers=ALICE)
    assert "hook_update:" + REPO not in fake.call_log


def test_repair_requires_admin(client):
    ws, pid = _project(client, member="bob")
    _repo_created(client, ws["id"], pid, events=["push"])
    res = client.post(f"/projects/{pid}/deployment/repair-webhook", headers=BOB)
    assert res.status_code == 403


def test_repair_refuses_before_the_repo_exists(client):
    _ws, pid = _project(client)
    res = client.post(f"/projects/{pid}/deployment/repair-webhook", headers=ALICE)
    assert res.status_code == 409
    assert res.json()["detail"] == "repo_not_created"


# --------------------------------------------------------------------------- #
# Probe safety
# --------------------------------------------------------------------------- #
# `environment_url` is chosen by the workflow, and a workflow is editable by
# anyone with push access to the project repo. Without these guards, probing
# it is a server-side request forgery primitive into the cloud's own network,
# answered by the three-valued frame_policy oracle.
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8080/admin",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data/",  # cloud instance metadata
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://[::1]/",
        "file:///etc/passwd",
        "gopher://127.0.0.1:11211/",
        "not a url at all",
        "http://",
    ],
)
def test_probe_refuses_non_public_targets(url):
    from app.api.github import _probe_target_is_public

    assert _probe_target_is_public(url) is False


def test_probe_accepts_an_ordinary_public_host():
    from app.api.github import _probe_target_is_public

    # example.com is IANA-reserved for documentation and resolves publicly.
    assert _probe_target_is_public("https://example.com/index.html") is True


def test_probe_is_not_attempted_for_a_private_target(client, monkeypatch):
    """The guard must run before any request leaves the process — asserting on
    the return value alone would pass even if the request had been made."""
    import httpx

    def explode(*_args, **_kwargs):
        raise AssertionError("a request was made to a non-public target")

    monkeypatch.setattr(httpx.AsyncClient, "head", explode)
    monkeypatch.setattr(httpx.AsyncClient, "get", explode)

    _ws, pid = _project(client)
    client.app.state.settings.deploy_r2_public_base_url = "http://127.0.0.1:9000"
    res = _post(
        client,
        "deployment_status",
        _deployment_status(
            pid, state="success", url=f"http://127.0.0.1:9000/previews/{pid}/index.html"
        ),
    )
    assert res.status_code == 200
    # "unknown" is what a refused probe records — the honest answer, and the
    # one the web app treats as "embed but keep the link prominent".
    assert _status(client, pid)["last_deploy"]["frame_policy"] == "unknown"


def test_reported_url_outside_the_provisioned_prefix_is_ignored(client):
    """A repo pusher must not be able to choose what the workspace's Preview
    tab embeds and what its project list links to."""
    _ws, pid = _project(client)
    _post(
        client,
        "deployment_status",
        _deployment_status(pid, state="success", url="https://attacker.test/looks-like-promptzone"),
    )
    body = _status(client, pid)
    assert body["url"] is None
    assert body["state"] == "live"


def test_a_provider_minted_url_is_taken_as_given(client):
    """Only platform-minted URLs have an expected value to pin against; a
    provider's own URL is unpredictable by design."""
    from app.api.github import _trusted_environment_url
    from app.deployments.registry import DeploymentTemplate

    template = DeploymentTemplate(
        id="x",
        name="X",
        description="",
        stack="static",
        provider="vercel",
        provider_credential_kind="vercel",
        scaffold_dir="static-r2",
        url_kind="provider",
    )

    class _Project:
        id = "p1"

    assert (
        _trusted_environment_url(client.app, _Project(), template, "https://x.vercel.app/")
        == "https://x.vercel.app/"
    )


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(document.domain)",
        "JavaScript:alert(1)",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "/relative/path",
        "https://",
        "not a url",
    ],
)
def test_non_web_urls_are_never_stored(client, url):
    """The stored URL is rendered by the web app as an `<a href>` and an
    `<iframe src>`, so a javascript: URL here is script execution in the
    workspace's own origin for every member who opens the project. The probe's
    SSRF guard does not cover this: it decides whether *we* may fetch a URL and
    never runs on the storage path."""
    _ws, pid = _project(client)
    res = _post(client, "deployment_status", _deployment_status(pid, state="success", url=url))
    assert res.status_code == 200
    assert _status(client, pid)["url"] is None


def test_scheme_is_checked_even_for_provider_minted_urls(client):
    """A provider template has no expected prefix to pin against, so the
    scheme check is the only thing standing between its report and an href."""
    from app.api.github import _trusted_environment_url
    from app.deployments.registry import DeploymentTemplate

    template = DeploymentTemplate(
        id="x",
        name="X",
        description="",
        stack="static",
        provider="vercel",
        provider_credential_kind="vercel",
        scaffold_dir="static-r2",
        url_kind="provider",
    )

    class _Project:
        id = "p1"

    assert (
        _trusted_environment_url(client.app, _Project(), template, "javascript:alert(1)") is None
    )
    assert (
        _trusted_environment_url(client.app, _Project(), template, "https://x.vercel.app/")
        == "https://x.vercel.app/"
    )


def test_the_status_endpoint_names_the_tasks_in_each_build(client):
    _ws, project_id = _project(client)
    repository = client.app.state.repository
    repository.upsert_graph(
        project_id,
        GraphUpsertRequest(
            tasks=[
                Task(id="t1", project_id=project_id, title="Add a retry", feature_tag="T001 [P]")
            ]
        ),
        source="pz",
    )
    _post(client, "deployment_status", _deployment_status(project_id, state="success"))
    row = repository.get_latest_deployment(project_id)
    repository.set_deployment_tasks(row.id, ["t1"])

    body = _status(client, project_id)
    assert body["last_deploy"]["tasks"] == [{"id": "t1", "title": "Add a retry", "ref": "T1"}]
    assert body["recent"][0]["tasks"] == body["last_deploy"]["tasks"]


def test_a_task_deleted_after_the_build_is_simply_omitted(client):
    _ws, project_id = _project(client)
    _post(client, "deployment_status", _deployment_status(project_id, state="success"))
    row = client.app.state.repository.get_latest_deployment(project_id)
    client.app.state.repository.set_deployment_tasks(row.id, ["gone"])
    body = _status(client, project_id)
    assert body["last_deploy"]["tasks"] == []
