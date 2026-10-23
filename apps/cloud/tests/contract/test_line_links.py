"""`pw_project_line_links`, `pw_line_link_codes` and `pw_workspaces.language` on
either adapter (plan 0032 M1). A memory-only suite would pass against a database
where migration 0010 was never applied."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import Repository
from app.models.schemas import LineLinkCode, ProjectLineLink, utcnow

from . import _helpers as h

pytestmark = pytest.mark.contract


def _link(project_id: str, user: str, group_id: str, **kw) -> ProjectLineLink:
    return ProjectLineLink(
        project_id=project_id, group_id=group_id, linked_by=user, linked_at=utcnow(), **kw
    )


def _code(project_id: str, user: str, code: str, minutes: int = 15) -> LineLinkCode:
    return LineLinkCode(
        code=code,
        project_id=project_id,
        created_by=user,
        expires_at=utcnow() + timedelta(minutes=minutes),
    )


def test_workspace_language_round_trips(repo: Repository) -> None:
    ws, _ = h.workspace(repo)
    assert repo.get_workspace(ws.id).language == "en"
    assert repo.update_workspace(ws.id, language="th").language == "th"
    assert repo.get_workspace(ws.id).language == "th"


def test_link_upsert_replaces_and_deletes(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    repo.set_project_line_link(_link(project.id, admin, "C1"))
    repo.set_project_line_link(_link(project.id, admin, "C2", group_name="Team"))
    stored = repo.get_project_line_link(project.id)
    assert (stored.group_id, stored.group_name) == ("C2", "Team")
    assert repo.delete_project_line_link(project.id) is True
    assert repo.delete_project_line_link(project.id) is False


def test_delete_links_for_group(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    a, b = h.project(repo, ws, admin), h.project(repo, ws, admin)
    group = f"G{a.id[:8]}"
    repo.set_project_line_link(_link(a.id, admin, group))
    repo.set_project_line_link(_link(b.id, admin, group))
    assert repo.delete_line_links_for_group(group) == 2
    assert repo.get_project_line_link(a.id) is None


def test_code_is_single_use_expires_and_is_replaced(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    tag = project.id[:8]
    repo.put_line_link_code(_code(project.id, admin, f"A{tag}"))
    repo.put_line_link_code(_code(project.id, admin, f"B{tag}"))
    assert repo.take_line_link_code(f"A{tag}", utcnow()) is None
    assert repo.take_line_link_code(f"B{tag}", utcnow()) is not None
    assert repo.take_line_link_code(f"B{tag}", utcnow()) is None

    repo.put_line_link_code(_code(project.id, admin, f"C{tag}"))
    assert repo.take_line_link_code(f"C{tag}", utcnow() + timedelta(minutes=16)) is None
    assert repo.take_line_link_code(f"C{tag}", utcnow()) is None
