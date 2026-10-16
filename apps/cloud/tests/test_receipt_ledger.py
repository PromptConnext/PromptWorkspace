"""Which receipts a decision implies, and how they are appended (D1)."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.db.repository import InMemoryRepository, ReceiptConflict
from app.delivery.ledger import append_receipt, expected_events, sync_decision_receipts
from app.delivery.receipts import sha256_text, verify_chain
from app.models.schemas import Decision, ReceiptDraft, utcnow


def _decision(status="open", **extra):
    now = utcnow()
    return Decision(
        project_id="p", workspace_id="w", kind="plan_approval", title="t",
        subject_stage="tasks", subject_hash="h" * 64, routed_hat="tech_steward",
        status=status, requested_by="bob", created_at=extra.pop("created_at", now), **extra,
    )


def test_an_open_decision_implies_one_requested_receipt():
    (at, draft), = expected_events(_decision())
    assert draft.event == "decision.requested" and draft.actor == "bob"
    assert draft.body["subject_hash"] == "h" * 64 and draft.body["routed_hat"] == "tech_steward"


def test_an_approval_records_the_resolver_and_only_a_hash_of_the_rationale():
    d = _decision("approved", resolved_by="alice", resolved_at=utcnow(), rationale="Looks right")
    events = expected_events(d)
    assert [e.event for _, e in events] == ["decision.requested", "decision.approved"]
    approved = events[1][1]
    assert approved.actor == "alice"
    assert approved.body["rationale_sha256"] == sha256_text("Looks right")
    assert "Looks right" not in str(approved.body)


def test_a_withdrawal_without_a_resolver_is_attributed_to_the_system():
    d = _decision("withdrawn")
    assert expected_events(d)[1][1].actor == "system"


def test_sync_appends_missing_receipts_in_occurrence_order_and_is_idempotent():
    repo = InMemoryRepository()
    t0 = utcnow()
    old = _decision("withdrawn", created_at=t0, resolved_by="bob",
                    resolved_at=t0 + timedelta(seconds=1))
    new = _decision(created_at=t0 + timedelta(seconds=2))

    assert sync_decision_receipts(repo, "p", [new, old]) == 3
    assert sync_decision_receipts(repo, "p", [new, old]) == 0

    chain = repo.list_receipts("p")
    assert [(r.subject_id, r.event) for r in chain] == [
        (old.id, "decision.requested"),
        (old.id, "decision.withdrawn"),
        (new.id, "decision.requested"),
    ]
    assert verify_chain(chain).ok


def test_sync_repairs_a_gap_left_by_an_earlier_failed_write():
    repo = InMemoryRepository()
    d = _decision()
    sync_decision_receipts(repo, "p", [d])
    resolved = d.model_copy(update={"status": "approved", "resolved_by": "alice",
                                    "resolved_at": utcnow()})
    # The approval's own sync never ran (crash); the next write repairs it.
    other = _decision()
    assert sync_decision_receipts(repo, "p", [other, resolved]) == 2
    assert [r.event for r in repo.list_receipts("p")][-2:] == [
        "decision.approved", "decision.requested"]


def test_sync_retries_after_losing_a_race():
    repo = InMemoryRepository()
    real_insert = repo.insert_receipt
    calls = {"n": 0}

    def flaky(receipt):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ReceiptConflict("seq taken")
        return real_insert(receipt)

    repo.insert_receipt = flaky
    assert sync_decision_receipts(repo, "p", [_decision()]) == 1
    assert len(repo.list_receipts("p")) == 1


def test_sync_never_raises_when_the_store_is_missing():
    repo = InMemoryRepository()

    def missing(_):
        from app.db.repository import DeliveryStoreUnavailable
        raise DeliveryStoreUnavailable()

    repo.insert_receipt = missing
    assert sync_decision_receipts(repo, "p", [_decision()]) == 0


def test_append_receipt_gives_up_after_the_attempts():
    repo = InMemoryRepository()

    def always(_):
        raise ReceiptConflict("seq taken")

    repo.insert_receipt = always
    draft = ReceiptDraft(project_id="p", workspace_id="w", event="role.assigned",
                         subject_type="project_role", subject_id="p:tech_steward", actor="a")
    with pytest.raises(ReceiptConflict):
        append_receipt(repo, draft, attempts=2)
