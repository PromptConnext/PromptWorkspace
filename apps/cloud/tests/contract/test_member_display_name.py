"""A member's display name belongs to the member: re-adding must not erase it."""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import Role, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_add_member_again_keeps_display_name(repo: Repository) -> None:
    member = new_id()
    ws, _admin = h.workspace(repo, members=(member,))
    repo.set_member_display_name(ws.id, member, "Somchai")

    repo.add_member(ws.id, member, Role.member, email="m@x.com")

    named = {m.user_id: m.display_name for m in repo.list_members(ws.id)}
    assert named[member] == "Somchai"
