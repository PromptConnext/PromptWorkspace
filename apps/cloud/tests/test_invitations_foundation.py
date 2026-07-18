from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from app.db.repository import InMemoryRepository
from app.main import create_app
from app.models.schemas import Invitation, InvitationStatus, utcnow


def _invite(**kw):
    base = dict(workspace_id="w1", email="a@b.com", invited_by="admin", expires_at=utcnow())
    base.update(kw)
    return Invitation(**base)


def utcnow_plus(days: int = 14):
    return utcnow() + timedelta(days=days)


def test_invitation_token_is_high_entropy_secret():
    import string

    tok = _invite().token
    # token_urlsafe(32) => 43 url-safe base64 chars; a uuid4 is 36 chars.
    assert len(tok) >= 43
    assert set(tok) <= set(string.ascii_letters + string.digits + "-_")


def test_two_invitations_get_distinct_tokens():
    assert _invite().token != _invite().token


def _repo_with_ws():
    repo = InMemoryRepository()
    ws = repo.create_workspace(name="Acme", created_by="admin")
    return repo, ws


def test_list_projects_by_workspace_scopes_to_that_workspace():
    repo, ws = _repo_with_ws()
    other = repo.create_workspace(name="Other", created_by="admin")
    p1 = repo.create_project(workspace_id=ws.id, created_by="admin", name="P1")
    repo.create_project(workspace_id=other.id, created_by="admin", name="P2")
    got = repo.list_projects_by_workspace(ws.id)
    assert [p.id for p in got] == [p1.id]


def test_list_invitations_filters_by_status():
    repo, ws = _repo_with_ws()
    inv = repo.create_invitation(
        Invitation(
            workspace_id=ws.id, email="a@b.com", invited_by="admin", expires_at=utcnow_plus()
        )
    )
    pending = repo.list_invitations(ws.id, status=InvitationStatus.pending)
    assert [i.id for i in pending] == [inv.id]
    # a revoked invite is excluded from a pending filter
    repo.revoke_invitation(ws.id, inv.id)
    assert repo.list_invitations(ws.id, status=InvitationStatus.pending) == []


def test_revoke_invitation_sets_status_and_guards():
    repo, ws = _repo_with_ws()
    inv = repo.create_invitation(
        Invitation(
            workspace_id=ws.id, email="a@b.com", invited_by="admin", expires_at=utcnow_plus()
        )
    )
    revoked = repo.revoke_invitation(ws.id, inv.id)
    assert revoked.status == InvitationStatus.revoked
    # revoking again (now non-pending) raises
    import pytest

    with pytest.raises(ValueError):
        repo.revoke_invitation(ws.id, inv.id)
    # unknown / cross-workspace id raises KeyError
    with pytest.raises(KeyError):
        repo.revoke_invitation(ws.id, "does-not-exist")


def _client():
    return TestClient(create_app())


def _mk_ws(c, user="alice", name="Acme"):
    return c.post("/workspaces", json={"name": name}, headers={"X-User-Id": user}).json()


def test_scoped_projects_endpoint_member_only():
    with _client() as c:
        ws = _mk_ws(c)
        c.post(
            "/projects",
            json={"name": "P1", "workspace_id": ws["id"]},
            headers={"X-User-Id": "alice"},
        )
        ok = c.get(f"/workspaces/{ws['id']}/projects", headers={"X-User-Id": "alice"})
        assert ok.status_code == 200
        assert [p["name"] for p in ok.json()] == ["P1"]
        denied = c.get(f"/workspaces/{ws['id']}/projects", headers={"X-User-Id": "mallory"})
        assert denied.status_code == 403


def test_list_and_revoke_invitations_admin_only():
    with _client() as c:
        ws = _mk_ws(c)
        inv = c.post(
            f"/workspaces/{ws['id']}/invitations",
            json={"email": "new@b.com", "role": "member"},
            headers={"X-User-Id": "alice"},
        ).json()
        # object under test in task 4 may wrap this; here we read the invitation id
        inv_id = inv["invitation"]["id"] if "invitation" in inv else inv["id"]

        listed = c.get(f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "alice"})
        assert listed.status_code == 200
        assert any(i["id"] == inv_id for i in listed.json())

        # non-admin cannot list
        assert c.get(
            f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "mallory"}
        ).status_code == 403

        # revoke
        rev = c.delete(
            f"/workspaces/{ws['id']}/invitations/{inv_id}", headers={"X-User-Id": "alice"}
        )
        assert rev.status_code == 204
        assert c.get(
            f"/workspaces/{ws['id']}/invitations", headers={"X-User-Id": "alice"}
        ).json() == []
        # revoking again → 409
        assert c.delete(
            f"/workspaces/{ws['id']}/invitations/{inv_id}", headers={"X-User-Id": "alice"}
        ).status_code == 409
