"""Connecting a customer-owned deployment provider (ADR 0023 phase 1).

The platform-owned R2 provider needs no connection; every other provider is a
token a workspace admin supplies, verified before storage exactly like the
GitHub PAT (app/api/github.py::connect_github).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.integrations import deploy_providers
from app.main import create_app
from app.models.schemas import Role

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        yield c


def _workspace(client: TestClient, *, member: str | None = None) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    if member:
        client.app.state.repository.add_member(ws["id"], member, Role.member, invited_by="alice")
    return ws["id"]


@pytest.fixture
def accepting_fly(monkeypatch):
    """Network-free verifier, the same seam FakeGithubClient gives the PAT."""
    calls: list[dict] = []

    async def verify(app, config):
        calls.append(config)
        return {}

    monkeypatch.setitem(
        deploy_providers.PROVIDERS,
        "fly",
        deploy_providers.PROVIDERS["fly"].__class__(
            id="fly",
            label="Fly.io",
            fields=deploy_providers.PROVIDERS["fly"].fields,
            verify=verify,
        ),
    )
    return calls


def test_an_admin_connects_a_provider(client, accepting_fly):
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "fly-token", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    assert res.status_code == 200
    assert res.json()["connected"] is True
    assert accepting_fly == [{"token": "fly-token", "app_name": "rocket", "org_slug": "acme"}]


def test_the_token_is_never_returned_and_never_stored_in_the_clear(client, accepting_fly):
    ws = _workspace(client)
    client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "fly-token", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    body = client.get(f"/workspaces/{ws}/integrations/deploy/fly", headers=ALICE).json()
    assert "fly-token" not in str(body)
    stored = client.app.state.repository.get_workspace(ws).integration_config["fly"]
    assert "fly-token" not in str(stored)
    assert stored["secret_ref"]


def test_a_rejected_token_is_not_stored(client, monkeypatch):
    async def verify(app, config):
        raise deploy_providers.ProviderCredentialError("deploy_token_rejected")

    monkeypatch.setitem(
        deploy_providers.PROVIDERS,
        "fly",
        deploy_providers.PROVIDERS["fly"].__class__(id="fly", label="Fly.io", verify=verify),
    )
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "bad", "values": {}},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "deploy_token_rejected"
    assert "fly" not in (client.app.state.repository.get_workspace(ws).integration_config or {})


def test_a_plain_member_cannot_connect(client, accepting_fly):
    ws = _workspace(client, member="bob")
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "t", "values": {}},
        headers=BOB,
    )
    assert res.status_code == 403


def test_disconnect_clears_the_block(client, accepting_fly):
    ws = _workspace(client)
    client.put(
        f"/workspaces/{ws}/integrations/deploy/fly",
        json={"token": "t", "values": {"app_name": "rocket", "org_slug": "acme"}},
        headers=ALICE,
    )
    res = client.delete(f"/workspaces/{ws}/integrations/deploy/fly", headers=ALICE)
    assert res.status_code == 200
    assert res.json()["connected"] is False


def test_the_platform_owned_provider_refuses_a_connection(client):
    ws = _workspace(client)
    res = client.put(
        f"/workspaces/{ws}/integrations/deploy/platform-r2",
        json={"token": "t", "values": {}},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "provider_is_platform_owned"


def test_an_unknown_provider_is_404(client):
    ws = _workspace(client)
    res = client.get(f"/workspaces/{ws}/integrations/deploy/nope", headers=ALICE)
    assert res.status_code == 404
