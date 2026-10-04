"""`pw_stage_inputs` on either adapter — the Planner form answers.

`inputs` is a jsonb column in Postgres and a dict in memory; the case that
matters is that what goes in as a str->str map comes back as one, and that a
second write replaces the first rather than merging into it.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_no_answers_read_as_none(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    assert repo.get_stage_inputs(project.id, "specify") is None


def test_answers_round_trip(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)

    repo.upsert_stage_inputs(
        project.id, ws.id, "specify", {"problem": "สวัสดี — waits", "audience": ""}, admin
    )
    stored = repo.get_stage_inputs(project.id, "specify")

    assert stored is not None
    assert stored.inputs == {"problem": "สวัสดี — waits", "audience": ""}
    assert stored.updated_by == admin
    assert stored.workspace_id == ws.id
    assert stored.stage == "specify"


def test_a_second_write_replaces_the_first(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)

    repo.upsert_stage_inputs(project.id, ws.id, "plan", {"a": "1", "b": "2"}, admin)
    repo.upsert_stage_inputs(project.id, ws.id, "plan", {"a": "3"}, admin)

    stored = repo.get_stage_inputs(project.id, "plan")
    assert stored is not None
    assert stored.inputs == {"a": "3"}


def test_stages_and_projects_are_independent(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    one = h.project(repo, ws, admin)
    two = h.project(repo, ws, admin)

    repo.upsert_stage_inputs(one.id, ws.id, "specify", {"a": "one"}, admin)

    assert repo.get_stage_inputs(one.id, "plan") is None
    assert repo.get_stage_inputs(two.id, "specify") is None


def test_answers_do_not_create_a_stage_document(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)

    repo.upsert_stage_inputs(project.id, ws.id, "specify", {"a": "x"}, admin)

    assert repo.get_stage_document(project.id, "specify") is None
