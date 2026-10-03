"""GitHub Pages as a third template and a third credential posture, and the
per-template preview-URL resolution it required (ADR 0023's 2026-09-06
amendment).

Two things are being pinned here. The template itself — host-owned credential,
nothing to connect, a workflow that opens its own `preview` deployment. And
the generalization underneath it: the expected preview URL is now resolved
from the template's declared source rather than by calling one provider's URL
helper, which is what makes the pin work for more than one template.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api.github import _trusted_environment_url
from app.deployments.preview_url import (
    platform_preview_url,
    repo_full_name_from_url,
    resolves_before_repo,
)
from app.deployments.registry import get_template, template_files
from app.integrations.deploy_providers import PROVIDERS
from app.main import create_app
from app.models.schemas import DeploymentConfig, Project

ALICE = {"X-User-Id": "alice"}
TEMPLATE = "github-pages"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


def _project(**overrides) -> Project:
    defaults = dict(name="Rocket", workspace_id="ws-1", owner_id="alice")
    defaults.update(overrides)
    return Project(**defaults)


def _workflow(template_id: str) -> str:
    return next(
        content
        for path, content, _ in template_files(template_id)
        if path == ".github/workflows/deploy.yml"
    )


# --------------------------------------------------------------------------- #
# The template
# --------------------------------------------------------------------------- #
def test_pages_needs_no_credential_from_anyone():
    template = get_template(TEMPLATE)
    assert template is not None
    # The whole point of this posture: no workspace block to key into, and no
    # secret sealed into the repository. The run's own token does the deploy.
    assert template.provider_credential_kind is None
    assert template.required_secrets == ()
    assert PROVIDERS[template.provider].credential_owner == "host"
    # Not "platform": PromptWorkspace is not the one serving the site.
    assert PROVIDERS[template.provider].credential_owner != "platform"


def test_pages_seeds_a_site_and_the_fixed_workflow_path():
    paths = {path for path, _, _ in template_files(TEMPLATE)}
    assert "site/index.html" in paths
    assert ".github/workflows/deploy.yml" in paths


def test_the_pages_workflow_opens_its_own_preview_deployment():
    """`actions/deploy-pages` records its deployment in the `github-pages`
    environment, and `_handle_deployment_status` filters hard on `preview`.
    Without this the cloud would watch a successful deploy go by and record
    nothing — and widening the filter would let a repo's own staging workflow
    report itself as the business user's preview."""
    workflow = _workflow(TEMPLATE)
    assert "vars.PROMPTWORKSPACE_ENVIRONMENT" in workflow
    assert workflow.index("Open deployment") < workflow.index("Deploy to Pages")
    assert "environment_url" in workflow


def test_the_pages_workflow_asks_for_the_permissions_pages_needs():
    workflow = _workflow(TEMPLATE)
    for permission in ("pages: write", "id-token: write", "deployments: write"):
        assert permission in workflow
    # Enabling Pages from the run is what keeps the workspace's own GitHub
    # token out of it — no Pages permission is needed on the PAT.
    assert "enablement: true" in workflow


def test_the_pages_workflow_references_no_secret_at_all():
    workflow = _workflow(TEMPLATE)
    assert "secrets." not in workflow
    assert "pull_request_target" not in workflow


def test_every_pinned_action_carries_a_sha_not_a_tag():
    for line in _workflow(TEMPLATE).splitlines():
        if "uses:" in line:
            ref = line.split("uses:", 1)[1].strip().split("#")[0].strip()
            _action, _, version = ref.partition("@")
            assert len(version) == 40, f"{ref} is not pinned to a commit sha"


# --------------------------------------------------------------------------- #
# Where a preview is expected to answer
# --------------------------------------------------------------------------- #
def test_a_pages_url_is_derived_from_the_repository(client):
    template = get_template(TEMPLATE)
    project = _project(repo_url="https://github.com/acme/rocket-ship")
    url = platform_preview_url(
        template, project=project, settings=client.app.state.settings
    )
    assert url == "https://acme.github.io/rocket-ship/"


def test_a_pages_url_cannot_be_known_before_the_repository_exists(client):
    template = get_template(TEMPLATE)
    assert resolves_before_repo(template) is False
    # No repo yet, so no URL — and repo creation must not treat that as the
    # failure it would be for any other platform-URL template.
    assert (
        platform_preview_url(template, project=_project(), settings=client.app.state.settings)
        is None
    )


def test_the_docker_host_url_comes_from_the_project(client):
    template = get_template("docker-compose")
    project = _project(
        deployment_config=DeploymentConfig(
            template_id="docker-compose",
            provider_values={"public_url": "https://rocket.example.com"},
        )
    )
    assert resolves_before_repo(template) is True
    assert (
        platform_preview_url(template, project=project, settings=client.app.state.settings)
        == "https://rocket.example.com"
    )


def test_a_provider_minted_url_has_no_expected_value(client):
    # Vercel picks the hostname, so there is nothing to compare a report to.
    assert get_template("next-vercel").platform_url_source == ""


@pytest.mark.parametrize(
    ("repo_url", "expected"),
    [
        ("https://github.com/acme/widget", "acme/widget"),
        ("https://github.com/acme/widget/", "acme/widget"),
        ("", None),
        (None, None),
        ("https://github.com", None),
    ],
)
def test_repo_full_name_is_derived_rather_than_stored(repo_url, expected):
    assert repo_full_name_from_url(repo_url) == expected


# --------------------------------------------------------------------------- #
# Pinning a reported URL
# --------------------------------------------------------------------------- #
def test_a_pages_deploy_reporting_its_own_address_is_trusted(client):
    project = _project(repo_url="https://github.com/acme/rocket-ship")
    assert (
        _trusted_environment_url(
            client.app, project, get_template(TEMPLATE), "https://acme.github.io/rocket-ship/"
        )
        == "https://acme.github.io/rocket-ship/"
    )


def test_a_pages_deploy_reporting_somewhere_else_is_ignored(client):
    """The workflow is editable by anyone with push access, so a reported URL
    outside the address this repository's Pages site actually has is not the
    preview we provisioned."""
    project = _project(repo_url="https://github.com/acme/rocket-ship")
    assert (
        _trusted_environment_url(
            client.app, project, get_template(TEMPLATE), "https://attacker.example.com/"
        )
        is None
    )


def test_a_docker_host_deploy_reporting_its_named_url_is_trusted(client):
    """Regression: this template declares `url_kind="platform"`, and while the
    expected URL was computed by calling the R2 helper directly, its reports
    were pinned against a prefix they could never match and were dropped —
    leaving a live preview whose URL never reached the Preview tab."""
    project = _project(
        repo_url="https://github.com/acme/rocket-ship",
        deployment_config=DeploymentConfig(
            template_id="docker-compose",
            provider_values={"public_url": "https://rocket.example.com/"},
        ),
    )
    assert (
        _trusted_environment_url(
            client.app,
            project,
            get_template("docker-compose"),
            "https://rocket.example.com/",
        )
        == "https://rocket.example.com/"
    )


def test_a_docker_host_deploy_reporting_another_host_is_ignored(client):
    project = _project(
        deployment_config=DeploymentConfig(
            template_id="docker-compose",
            provider_values={"public_url": "https://rocket.example.com/"},
        )
    )
    assert (
        _trusted_environment_url(
            client.app, project, get_template("docker-compose"), "https://elsewhere.example.com/"
        )
        is None
    )


# --------------------------------------------------------------------------- #
# The connect routes
# --------------------------------------------------------------------------- #
def test_the_host_owned_provider_refuses_a_connection_in_its_own_words(client):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()["id"]
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/github-pages",
        json={"token": "t", "values": {}},
        headers=ALICE,
    )
    assert res.status_code == 400
    # Its own code rather than the platform-owned one: both mean "nothing to
    # connect", but only one of them means PromptWorkspace is hosting it.
    assert res.json()["detail"] == "provider_is_host_owned"


def test_the_picker_is_told_who_owns_each_credential(client):
    templates = {t["id"]: t for t in client.get("/deployment-templates", headers=ALICE).json()}
    assert templates["github-pages"]["provider_credential_owner"] == "host"
    assert templates["static-r2"]["provider_credential_owner"] == "platform"
    assert templates["next-vercel"]["provider_credential_owner"] == "customer"
    # Pages needs no account, but "managed by PromptWorkspace" would be a lie, so
    # the boolean the picker used to lean on is False for it.
    assert templates["github-pages"]["provider_is_platform_owned"] is False
    assert templates["static-r2"]["provider_is_platform_owned"] is True
    assert templates["github-pages"]["required_secrets"] == []
