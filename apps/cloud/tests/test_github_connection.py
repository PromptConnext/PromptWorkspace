"""Workspace GitHub connection (PAT) — verification, storage posture, and the
admin gate.

The credential replaced a platform-wide GitHub App (ADR 0017 amendment). Two
properties matter enough to pin down here: the plaintext token must never be
readable back out through any route, and a token that cannot actually reach
the configured owner must be refused at save time rather than at tech-review
exit, hours later.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
TOKEN = "github_pat_11ABCDEF_secretvalue"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.github_client = FakeGithubClient()
        yield c


def _workspace(client: TestClient) -> str:
    return client.post("/workspaces", json={"name": "Acme"}, headers=ALICE).json()["id"]


def _connect(client: TestClient, ws_id: str, owner: str = "acme", token: str = TOKEN):
    return client.put(
        f"/workspaces/{ws_id}/integrations/github",
        json={"owner": owner, "token": token},
        headers=ALICE,
    )


def test_connect_stores_token_and_reports_status(client: TestClient):
    ws_id = _workspace(client)
    client.app.state.github_client.token_login = "alice-gh"
    client.app.state.github_client.token_expires_at = "2026-11-01T00:00:00+00:00"

    res = _connect(client, ws_id)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["connected"] is True
    assert body["owner"] == "acme"
    assert body["account_login"] == "alice-gh"
    assert body["token_expires_at"].startswith("2026-11-01")

    status = client.get(f"/workspaces/{ws_id}/integrations/github", headers=ALICE)
    assert status.json()["connected"] is True


def test_connection_response_never_carries_the_token(client: TestClient):
    ws_id = _workspace(client)
    res = _connect(client, ws_id)
    assert TOKEN not in res.text

    status = client.get(f"/workspaces/{ws_id}/integrations/github", headers=ALICE)
    assert TOKEN not in status.text
    assert "secret_ref" not in status.text

    # Nor through the workspace row itself, which members can read.
    ws = client.get(f"/workspaces/{ws_id}", headers=ALICE)
    assert TOKEN not in ws.text


def test_stored_token_is_encrypted_not_plaintext(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id)

    stored = client.app.state.repository.get_workspace(ws_id).integration_config["github"]
    assert stored["secret_ref"] != TOKEN
    assert client.app.state.secret_store.decrypt(stored["secret_ref"]) == TOKEN
    # No stray plaintext copy under another key.
    assert TOKEN not in str(stored)


def test_rejected_token_is_not_stored(client: TestClient):
    ws_id = _workspace(client)
    client.app.state.github_client.reject_token = True

    res = _connect(client, ws_id)
    assert res.status_code == 400
    assert res.json()["detail"] == "github_token_rejected"
    assert "github" not in client.app.state.repository.get_workspace(ws_id).integration_config


def test_token_that_cannot_reach_owner_is_refused(client: TestClient):
    # Caught at save time, not hours later at repo creation.
    ws_id = _workspace(client)
    client.app.state.github_client.token_owner_unreachable = True

    res = _connect(client, ws_id)
    assert res.status_code == 400
    assert res.json()["detail"] == "github_owner_not_accessible"
    assert "github" not in client.app.state.repository.get_workspace(ws_id).integration_config


def test_personal_account_owner_is_recorded_as_user(client: TestClient):
    ws_id = _workspace(client)
    client.app.state.github_client.token_login = "solo-dev"

    res = _connect(client, ws_id, owner="solo-dev")
    assert res.status_code == 200, res.text
    assert res.json()["owner_type"] == "User"


def test_disconnect_clears_the_credential(client: TestClient):
    ws_id = _workspace(client)
    _connect(client, ws_id)

    res = client.delete(f"/workspaces/{ws_id}/integrations/github", headers=ALICE)
    assert res.status_code == 200
    assert res.json()["connected"] is False
    assert "github" not in client.app.state.repository.get_workspace(ws_id).integration_config


def test_non_admin_cannot_connect_or_read(client: TestClient):
    ws_id = _workspace(client)
    assert (
        client.put(
            f"/workspaces/{ws_id}/integrations/github",
            json={"owner": "acme", "token": TOKEN},
            headers=BOB,
        ).status_code
        == 403
    )
    assert client.get(f"/workspaces/{ws_id}/integrations/github", headers=BOB).status_code == 403


def test_legacy_app_config_reads_as_not_connected(client: TestClient):
    """A workspace left over from the GitHub App era carries `installation_id`
    and no `secret_ref`. It must read as disconnected — half-working would mean
    settings says "connected" while every call path fails."""
    ws_id = _workspace(client)
    client.app.state.repository.update_workspace(
        ws_id, integration_config={"github": {"installation_id": "inst-1", "owner": "acme"}}
    )

    status = client.get(f"/workspaces/{ws_id}/integrations/github", headers=ALICE)
    assert status.json()["connected"] is False
