"""GET/PUT /workspaces/{id}/governance (plan 0033)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ALICE = {"X-User-Id": "alice"}  # creator, admin
BOB = {"X-User-Id": "bob"}  # member


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def workspace(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    token = inv["invitation"]["token"]
    assert client.post(f"/invitations/{token}/accept", headers=BOB).status_code == 200
    return ws["id"]


def _body(**kw) -> dict:
    body = {
        "policy_scope": {"selected": ["gdpr", "gdpr"], "custom_text": "keep it tidy"},
        "required_hats": ["tech_steward"],
        "require_seeded_rules": False,
    }
    body.update(kw)
    return body


def test_get_governance_default_without_row(client: TestClient, workspace: str) -> None:
    res = client.get(f"/workspaces/{workspace}/governance", headers=BOB)
    assert res.status_code == 200
    data = res.json()
    assert data["policy_scope"]["selected"] == []
    assert data["required_hats"] == ["business_owner", "tech_steward"]
    assert data["require_seeded_rules"] is True
    assert client.app.state.repository.get_workspace_governance(workspace) is None


def test_put_governance_admin_only(client: TestClient, workspace: str) -> None:
    res = client.put(f"/workspaces/{workspace}/governance", json=_body(), headers=BOB)
    assert res.status_code == 403


def test_put_governance_validates_template_ids_and_text_cap(
    client: TestClient, workspace: str
) -> None:
    url = f"/workspaces/{workspace}/governance"
    scope = {"selected": ["nope"], "custom_text": ""}
    bad = client.put(url, json=_body(policy_scope=scope), headers=ALICE)
    assert (bad.status_code, bad.json()["detail"]) == (422, "unknown_policy_template")
    scope = {"selected": [], "custom_text": "x" * 20_001}
    long = client.put(url, json=_body(policy_scope=scope), headers=ALICE)
    assert (long.status_code, long.json()["detail"]) == (422, "custom_text_too_long")
    hat = client.put(url, json=_body(required_hats=["ceo"]), headers=ALICE)
    assert (hat.status_code, hat.json()["detail"]) == (422, "unknown_hat")


def test_put_governance_round_trips(client: TestClient, workspace: str) -> None:
    url = f"/workspaces/{workspace}/governance"
    put = client.put(url, json=_body(), headers=ALICE)
    assert put.status_code == 200, put.text
    data = put.json()
    assert data["policy_scope"] == {"selected": ["gdpr"], "custom_text": "keep it tidy"}
    assert data["required_hats"] == ["tech_steward"]
    assert data["require_seeded_rules"] is False
    assert data["updated_by"] == "alice"
    assert client.get(url, headers=BOB).json() == data
