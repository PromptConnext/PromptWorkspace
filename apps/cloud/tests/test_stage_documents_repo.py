"""In-memory repository CRUD for stage_documents — the raw-markdown side
store for Planner stages, independent of the graph-entity persistence
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from app.db.repository import InMemoryRepository


def test_get_stage_document_returns_none_when_absent():
    repo = InMemoryRepository()
    assert repo.get_stage_document("proj-1", "plan") is None


def test_upsert_then_get_roundtrips_content():
    repo = InMemoryRepository()
    doc = repo.upsert_stage_document("proj-1", "ws-1", "plan", "# Plan\n\nDo the thing.", "user-1")
    assert doc.project_id == "proj-1"
    assert doc.stage == "plan"
    assert doc.content == "# Plan\n\nDo the thing."
    assert doc.created_by == "user-1"

    fetched = repo.get_stage_document("proj-1", "plan")
    assert fetched is not None
    assert fetched.content == "# Plan\n\nDo the thing."


def test_upsert_overwrites_existing_content_for_same_stage():
    repo = InMemoryRepository()
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "first draft", "user-1")
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "second draft", "user-1")

    fetched = repo.get_stage_document("proj-1", "plan")
    assert fetched is not None
    assert fetched.content == "second draft"


def test_different_stages_are_independent():
    repo = InMemoryRepository()
    repo.upsert_stage_document("proj-1", "ws-1", "specify", "specify content", "user-1")
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "plan content", "user-1")

    assert repo.get_stage_document("proj-1", "specify").content == "specify content"
    assert repo.get_stage_document("proj-1", "plan").content == "plan content"
