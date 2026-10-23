"""Storage for LINE notifications (plan 0032 M1): workspace language and the
project-to-group link plus its pending single-use code, on the in-memory adapter.
The same repository cases run against both adapters in tests/contract/."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import InMemoryRepository
from app.models.schemas import LineLinkCode, ProjectLineLink, new_id, utcnow


@pytest.fixture
def repo() -> InMemoryRepository:
    return InMemoryRepository()


def _link(project_id: str, group_id: str = "C1", **overrides) -> ProjectLineLink:
    fields = dict(project_id=project_id, group_id=group_id, linked_by="u1", linked_at=utcnow())
    fields.update(overrides)
    return ProjectLineLink(**fields)


def _code(project_id: str, code: str = "ABC123", minutes: int = 15) -> LineLinkCode:
    return LineLinkCode(
        code=code,
        project_id=project_id,
        created_by="u1",
        expires_at=utcnow() + timedelta(minutes=minutes),
    )


def test_workspace_language_defaults_to_en_and_updates(client):
    headers = {"X-User-Id": "alice"}
    ws = client.post("/workspaces", json={"name": "Acme"}, headers=headers).json()
    assert ws["language"] == "en"

    res = client.patch(f"/workspaces/{ws['id']}", json={"language": "th"}, headers=headers)
    assert res.status_code == 200, res.text
    assert res.json()["language"] == "th"
    assert client.get(f"/workspaces/{ws['id']}", headers=headers).json()["language"] == "th"

    res = client.patch(f"/workspaces/{ws['id']}", json={"language": "fr"}, headers=headers)
    assert res.status_code == 422


def test_line_link_upsert_replaces_and_deletes(repo):
    pid = new_id()
    assert repo.get_project_line_link(pid) is None

    repo.set_project_line_link(_link(pid, "C1"))
    repo.set_project_line_link(_link(pid, "C2", group_name="Team"))
    stored = repo.get_project_line_link(pid)
    assert stored is not None
    assert (stored.group_id, stored.group_name) == ("C2", "Team")

    assert repo.delete_project_line_link(pid) is True
    assert repo.get_project_line_link(pid) is None
    assert repo.delete_project_line_link(pid) is False


def test_delete_links_for_group_clears_every_project_on_it(repo):
    a, b, c = new_id(), new_id(), new_id()
    repo.set_project_line_link(_link(a, "G"))
    repo.set_project_line_link(_link(b, "G"))
    repo.set_project_line_link(_link(c, "OTHER"))

    assert repo.delete_line_links_for_group("G") == 2
    assert repo.get_project_line_link(a) is None
    assert repo.get_project_line_link(b) is None
    assert repo.get_project_line_link(c) is not None
    assert repo.delete_line_links_for_group("G") == 0


def test_link_code_is_single_use_and_expires(repo):
    pid = new_id()
    repo.put_line_link_code(_code(pid, "ONCE"))
    taken = repo.take_line_link_code("ONCE", utcnow())
    assert taken is not None and taken.project_id == pid
    assert repo.take_line_link_code("ONCE", utcnow()) is None

    repo.put_line_link_code(_code(pid, "OLD", minutes=15))
    assert repo.take_line_link_code("OLD", utcnow() + timedelta(minutes=16)) is None
    # The expired code was deleted, not left to be taken by a clock that rewinds.
    assert repo.take_line_link_code("OLD", utcnow()) is None


def test_new_code_replaces_unused_code_for_project(repo):
    pid, other = new_id(), new_id()
    repo.put_line_link_code(_code(pid, "FIRST"))
    repo.put_line_link_code(_code(other, "THEIRS"))
    repo.put_line_link_code(_code(pid, "SECOND"))

    assert repo.take_line_link_code("FIRST", utcnow()) is None
    assert repo.take_line_link_code("SECOND", utcnow()) is not None
    assert repo.take_line_link_code("THEIRS", utcnow()) is not None
