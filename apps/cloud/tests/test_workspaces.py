"""Tests for workspaces, membership, invitations, and auth modes (M2)."""

from __future__ import annotations

import jwt
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


def _ws(client, name="Acme", user="alice"):
    res = client.post("/workspaces", json={"name": name}, headers={"X-User-Id": user})
    assert res.status_code == 201, res.text
    return res.json()


def test_create_workspace_makes_creator_admin(client):
    ws = _ws(client, user="alice")
    members = client.get(
        f"/workspaces/{ws['id']}/members", headers={"X-User-Id": "alice"}
    ).json()
    assert len(members) == 1
    assert members[0]["user_id"] == "alice"
    assert members[0]["role"] == "admin"


def test_member_can_access_projects_in_workspace(client):
    ws = _ws(client, user="alice")
    res = client.post(
        "/projects",
        json={"name": "P1", "workspace_id": ws["id"]},
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 201, res.text
    listed = client.get("/projects", headers={"X-User-Id": "alice"}).json()
    assert len(listed) == 1


def test_non_member_cannot_access_workspace_projects(client):
    ws = _ws(client, user="alice")
    proj = client.post(
        "/projects",
        json={"name": "P1", "workspace_id": ws["id"]},
        headers={"X-User-Id": "alice"},
    ).json()

    # Bob is not a member: cannot read the workspace, create in it, or see the project.
    assert client.get(f"/workspaces/{ws['id']}", headers={"X-User-Id": "bob"}).status_code == 403
    assert (
        client.post(
            "/projects",
            json={"name": "X", "workspace_id": ws["id"]},
            headers={"X-User-Id": "bob"},
        ).status_code
        == 403
    )
    assert (
        client.get(f"/projects/{proj['id']}", headers={"X-User-Id": "bob"}).status_code == 403
    )
    assert client.get("/projects", headers={"X-User-Id": "bob"}).json() == []


def test_only_admin_can_invite_and_edit_git_config(client):
    ws = _ws(client, user="alice")
    # Add bob as a plain member via an invitation alice creates.
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations",
        json={"email": "bob@x.com"},
        headers={"X-User-Id": "alice"},
    ).json()
    client.post(
        f"/invitations/{inv['invitation']['token']}/accept", headers={"X-User-Id": "bob"}
    )

    # Member bob cannot invite or edit git config.
    assert (
        client.post(
            f"/workspaces/{ws['id']}/invitations",
            json={"email": "carol@x.com"},
            headers={"X-User-Id": "bob"},
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/workspaces/{ws['id']}",
            json={"git_config": {"repo_url": "https://github.com/acme/repo"}},
            headers={"X-User-Id": "bob"},
        ).status_code
        == 403
    )

    # Admin alice can.
    patched = client.patch(
        f"/workspaces/{ws['id']}",
        json={"git_config": {"repo_url": "https://github.com/acme/repo"}},
        headers={"X-User-Id": "alice"},
    )
    assert patched.status_code == 200
    assert patched.json()["git_config"]["repo_url"] == "https://github.com/acme/repo"


def test_invitation_accept_adds_member(client):
    ws = _ws(client, user="alice")
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations",
        json={"email": "bob@x.com", "role": "member"},
        headers={"X-User-Id": "alice"},
    ).json()

    accepted = client.post(
        f"/invitations/{inv['invitation']['token']}/accept", headers={"X-User-Id": "bob"}
    )
    assert accepted.status_code == 200
    assert accepted.json()["user_id"] == "bob"

    members = client.get(
        f"/workspaces/{ws['id']}/members", headers={"X-User-Id": "alice"}
    ).json()
    assert {m["user_id"] for m in members} == {"alice", "bob"}

    # Re-accepting the same (now consumed) invitation is rejected.
    again = client.post(
        f"/invitations/{inv['invitation']['token']}/accept", headers={"X-User-Id": "bob"}
    )
    assert again.status_code == 409


def test_cross_workspace_isolation(client):
    ws_a = _ws(client, name="A", user="alice")
    ws_b = _ws(client, name="B", user="bob")
    client.post(
        "/projects",
        json={"name": "PA", "workspace_id": ws_a["id"]},
        headers={"X-User-Id": "alice"},
    )
    client.post(
        "/projects",
        json={"name": "PB", "workspace_id": ws_b["id"]},
        headers={"X-User-Id": "bob"},
    )
    # Each only sees their own workspace's projects.
    assert [p["name"] for p in client.get("/projects", headers={"X-User-Id": "alice"}).json()] == [
        "PA"
    ]
    assert [p["name"] for p in client.get("/projects", headers={"X-User-Id": "bob"}).json()] == [
        "PB"
    ]


# --------------------------------------------------------------------------- #
# Supabase JWT auth mode
# --------------------------------------------------------------------------- #
JWT_SECRET = "test-secret-please-change-0123456789abcdef"


@pytest.fixture
def jwt_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("AUTH_MODE", "supabase")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", JWT_SECRET)
    # get_settings is lru_cached; clear so the env override takes effect.
    from app.config import get_settings

    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def _bearer(sub: str, email: str = "u@x.com") -> dict:
    token = jwt.encode(
        {"sub": sub, "email": email, "aud": "authenticated"}, JWT_SECRET, algorithm="HS256"
    )
    return {"Authorization": f"Bearer {token}"}


def test_jwt_required_when_auth_mode_supabase(jwt_client):
    # No token → 401.
    assert jwt_client.post("/workspaces", json={"name": "W"}).status_code == 401
    # Garbage token → 401.
    assert (
        jwt_client.post(
            "/workspaces", json={"name": "W"}, headers={"Authorization": "Bearer nope"}
        ).status_code
        == 401
    )
    # Valid HS256 token minted with the configured secret → works, and the
    # identity comes from `sub`.
    res = jwt_client.post("/workspaces", json={"name": "W"}, headers=_bearer("user-123"))
    assert res.status_code == 201
    assert res.json()["created_by"] == "user-123"
