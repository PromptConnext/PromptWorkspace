"""The receipt store (enterprise AI v2.1 D1), against both adapters."""

from __future__ import annotations

import pytest

from app.db.repository import ReceiptConflict, Repository
from app.delivery.receipts import seal, verify_chain
from app.models.schemas import ReceiptDraft, new_id

from . import _helpers as h

pytestmark = pytest.mark.contract


def _draft(project, ws, subject_id=None, event="decision.requested", subject_type="decision"):
    return ReceiptDraft(
        project_id=project.id, workspace_id=ws.id, event=event, subject_type=subject_type,
        subject_id=subject_id or new_id(), actor="alice", body={"kind": "plan_approval"},
    )


def test_receipts_round_trip_oldest_first_and_still_verify(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.insert_receipt(seal(_draft(project, ws), None))
    second = repo.insert_receipt(seal(_draft(project, ws), first))

    stored = repo.list_receipts(project.id)

    assert [r.seq for r in stored] == [1, 2]
    assert stored[1].prev_hash == first.hash and stored[1].hash == second.hash
    # Review focus 2: timestamps and jsonb survive the store byte-for-byte.
    assert verify_chain(stored).ok


def test_a_taken_seq_is_a_conflict(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    first = repo.insert_receipt(seal(_draft(project, ws), None))

    with pytest.raises(ReceiptConflict):
        repo.insert_receipt(seal(_draft(project, ws), None))

    assert [r.id for r in repo.list_receipts(project.id)] == [first.id]


def test_a_decision_event_is_recorded_once(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    sid = new_id()
    first = repo.insert_receipt(seal(_draft(project, ws, subject_id=sid), None))

    with pytest.raises(ReceiptConflict):
        repo.insert_receipt(seal(_draft(project, ws, subject_id=sid), first))

    assert [r.id for r in repo.list_receipts(project.id)] == [first.id]


def test_role_events_may_repeat(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    project = h.project(repo, ws, admin)
    subject = f"{project.id}:tech_steward"
    a = repo.insert_receipt(
        seal(_draft(project, ws, subject, "role.assigned", "project_role"), None))
    repo.insert_receipt(seal(_draft(project, ws, subject, "role.assigned", "project_role"), a))

    assert len(repo.list_receipts(project.id)) == 2


def test_chains_are_per_project(repo: Repository) -> None:
    ws, admin = h.workspace(repo)
    one, two = h.project(repo, ws, admin), h.project(repo, ws, admin)
    repo.insert_receipt(seal(_draft(one, ws), None))
    repo.insert_receipt(seal(_draft(two, ws), None))

    assert [r.seq for r in repo.list_receipts(one.id)] == [1]
    assert [r.seq for r in repo.list_receipts(two.id)] == [1]
