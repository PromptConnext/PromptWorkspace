from __future__ import annotations

from app.models.schemas import Invitation, utcnow


def _invite(**kw):
    base = dict(workspace_id="w1", email="a@b.com", invited_by="admin", expires_at=utcnow())
    base.update(kw)
    return Invitation(**base)


def test_invitation_token_is_high_entropy_secret():
    tok = _invite().token
    # token_urlsafe(32) yields 43 url-safe chars; a uuid4 is 36 chars with dashes.
    assert "-" not in tok
    assert len(tok) >= 43


def test_two_invitations_get_distinct_tokens():
    assert _invite().token != _invite().token
