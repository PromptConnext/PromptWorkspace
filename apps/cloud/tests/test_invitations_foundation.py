from __future__ import annotations

from datetime import timedelta

from app.db.repository import InMemoryRepository
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
