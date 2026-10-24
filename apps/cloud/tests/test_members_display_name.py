"""PATCH /workspaces/{id}/members/{user_id} — member display names (plan 0033)."""

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
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200, accept.text
    return ws["id"]


def test_member_sets_own_display_name(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/bob", json={"display_name": " Somchai "}, headers=BOB
    )
    assert r.status_code == 200 and r.json()["display_name"] == "Somchai"
    members = client.get(f"/workspaces/{workspace}/members", headers=BOB).json()
    assert [m["display_name"] for m in members if m["user_id"] == "bob"] == ["Somchai"]


def test_member_cannot_rename_other(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/alice", json={"display_name": "X"}, headers=BOB
    )
    assert r.status_code == 403 and r.json()["detail"] == "display_name_forbidden"


def test_admin_renames_anyone_and_clears(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/bob", json={"display_name": "B"}, headers=ALICE
    )
    assert r.status_code == 200
    r = client.patch(
        f"/workspaces/{workspace}/members/bob", json={"display_name": None}, headers=ALICE
    )
    assert r.json()["display_name"] is None


def test_blank_display_name_becomes_none(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/bob", json={"display_name": "   "}, headers=BOB
    )
    assert r.status_code == 200 and r.json()["display_name"] is None


def test_unknown_member_404(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/ghost", json={"display_name": "G"}, headers=ALICE
    )
    assert r.status_code == 404 and r.json()["detail"] == "member_not_found"


def test_display_name_length_capped(client, workspace):
    r = client.patch(
        f"/workspaces/{workspace}/members/bob", json={"display_name": "x" * 81}, headers=BOB
    )
    assert r.status_code == 422
