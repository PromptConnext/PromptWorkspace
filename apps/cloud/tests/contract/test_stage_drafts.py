"""`pw_stage_drafts` on either adapter (local-agent brownfield planning).

One row per (project, stage): an upsert replaces the row wholesale, id
included, and a delete says whether there was anything to delete. Run against
memory in CI and against Supabase nightly, so a migration that never landed
fails here rather than in the agent's first submission.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository
from app.models.schemas import StageDraft

from . import _helpers as h

pytestmark = pytest.mark.contract


def _draft(project_id: str, workspace_id: str, created_by: str, **overrides) -> StageDraft:
    fields = dict(
        project_id=project_id,
        workspace_id=workspace_id,
        stage="specify",
        markdown="# Spec\n\nBook a slot.",
        model="claude-opus-5-5",
        created_by=created_by,
    )
    fields.update(overrides)
    return StageDraft(**fields)


def test_a_draft_round_trips(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    draft = _draft(project.id, ws.id, admin, rejection_note="Too vague", status="rejected")

    repo.upsert_stage_draft(draft)
    stored = repo.get_stage_draft(project.id, "specify")

    assert stored is not None
    assert stored.id == draft.id
    assert (stored.markdown, stored.source, stored.model) == (
        "# Spec\n\nBook a slot.",
        "agent",
        "claude-opus-5-5",
    )
    assert (stored.status, stored.rejection_note, stored.last_error) == (
        "rejected",
        "Too vague",
        None,
    )
    assert stored.created_by == admin
    assert stored.created_at == draft.created_at
    assert [d.id for d in repo.list_stage_drafts(project.id)] == [draft.id]


def test_an_upsert_replaces_the_stages_draft_and_the_new_id_wins(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.upsert_stage_draft(_draft(project.id, ws.id, admin))

    second = _draft(project.id, ws.id, admin, markdown="# Spec v2", last_error="graph_write_failed")
    repo.upsert_stage_draft(second)
    stored = repo.get_stage_draft(project.id, "specify")

    assert stored.id == second.id != first.id
    assert stored.markdown == "# Spec v2"
    assert stored.last_error == "graph_write_failed"
    assert len(repo.list_stage_drafts(project.id)) == 1


def test_delete_says_whether_a_draft_existed(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    repo.upsert_stage_draft(_draft(project.id, ws.id, admin))

    assert repo.delete_stage_draft(project.id, "specify") is True
    assert repo.get_stage_draft(project.id, "specify") is None
    assert repo.delete_stage_draft(project.id, "specify") is False


def test_drafts_are_per_project_and_per_stage(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    one = h.project(repo, ws, admin)
    other = h.project(repo, ws, admin)
    repo.upsert_stage_draft(_draft(one.id, ws.id, admin))
    repo.upsert_stage_draft(_draft(one.id, ws.id, admin, stage="plan", markdown="# Plan"))

    assert {d.stage for d in repo.list_stage_drafts(one.id)} == {"specify", "plan"}
    assert repo.list_stage_drafts(other.id) == []
    assert repo.get_stage_draft(other.id, "specify") is None
    assert repo.delete_stage_draft(other.id, "specify") is False
    assert repo.get_stage_draft(one.id, "specify") is not None
