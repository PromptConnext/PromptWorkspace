"""`list_projects_by_repo_ids` on either adapter: the batch form of
`find_project_by_repo_id`, which the import picker uses to mark repositories a
project already claimed without one lookup per repository."""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _repo_id() -> int:
    return int(new_id().replace("-", "")[:12], 16)


def _imported(repo: Repository, ws, admin: str, repo_id: int | None):
    return repo.create_project(
        ws.id,
        admin,
        f"imported-{new_id()[:8]}",
        repo_url=None if repo_id is None else f"https://github.com/acme/r{repo_id}",
        repo_default_branch="main",
        repo_id=repo_id,
        repo_origin="imported" if repo_id is not None else None,
    )


def test_projects_by_repo_ids_finds_each_claimed_repo_in_any_workspace(repo: Repository) -> None:
    ws_a, admin_a = h.workspace(repo)
    ws_b, admin_b = h.workspace(repo)
    id_a, id_b, unclaimed = _repo_id(), _repo_id(), _repo_id()
    first = _imported(repo, ws_a, admin_a, id_a)
    second = _imported(repo, ws_b, admin_b, id_b)
    _imported(repo, ws_a, admin_a, None)  # a project with no repository

    found = repo.list_projects_by_repo_ids([id_a, id_b, unclaimed])

    assert {p.repo_id: p.id for p in found} == {id_a: first.id, id_b: second.id}


def test_projects_by_repo_ids_of_nothing_is_empty(repo: Repository) -> None:
    assert repo.list_projects_by_repo_ids([]) == []
