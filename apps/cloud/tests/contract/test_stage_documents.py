"""`pw_stage_documents` read several stages at a time, on either adapter.

`list_stage_documents` exists so the approval reads fetch every stage they
hash in one request instead of one per stage; it must answer exactly what
`get_stage_document` answers for each stage, including leaving out a stage
that has no document.
"""

from __future__ import annotations

import pytest

from app.db.repository import Repository

from . import _helpers as h

pytestmark = pytest.mark.contract


def test_list_stage_documents_matches_get_stage_document(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    other = h.project(repo, ws, admin)
    repo.upsert_stage_document(project.id, ws.id, "specify", "# Spec\n\nBook a slot.", admin)
    repo.upsert_stage_document(project.id, ws.id, "tasks", "# Tasks\n\n- [ ] T001", admin)
    repo.upsert_stage_document(project.id, ws.id, "plan", "", admin)  # present but blank
    repo.upsert_stage_document(other.id, ws.id, "constitution", "# Other project", admin)

    docs = repo.list_stage_documents(project.id, ["specify", "tasks", "plan", "constitution"])

    # Only the stages asked for, and only those that have a document, blank
    # ones included (what counts as approvable is the caller's rule).
    assert set(docs) == {"specify", "tasks", "plan"}
    assert docs["plan"].content == ""
    for stage, doc in docs.items():
        single = repo.get_stage_document(project.id, stage)
        assert single is not None
        assert doc.model_dump() == single.model_dump()


def test_list_stage_documents_of_nothing_is_empty(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    assert repo.list_stage_documents(project.id, ["specify", "tasks"]) == {}
    assert repo.list_stage_documents(project.id, []) == {}
