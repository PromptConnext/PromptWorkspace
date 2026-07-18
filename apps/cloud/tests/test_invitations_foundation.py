from __future__ import annotations

from app.models.schemas import Invitation, utcnow


def _invite(**kw):
    base = dict(workspace_id="w1", email="a@b.com", invited_by="admin", expires_at=utcnow())
    base.update(kw)
    return Invitation(**base)


def test_invitation_token_is_high_entropy_secret():
    import string

    tok = _invite().token
    # token_urlsafe(32) => 43 url-safe base64 chars; a uuid4 is 36 chars.
    assert len(tok) >= 43
    assert set(tok) <= set(string.ascii_letters + string.digits + "-_")


def test_two_invitations_get_distinct_tokens():
    assert _invite().token != _invite().token
