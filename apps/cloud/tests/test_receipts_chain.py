"""Hash-chained receipts (enterprise AI v2.1 D1): sealing and verification.
Pure functions, so every way a chain can break is pinned."""

from __future__ import annotations

from datetime import datetime, timezone

from app.delivery.receipts import GENESIS, receipt_hash, seal, stamp, verify_chain
from app.models.schemas import ReceiptDraft


def _draft(event="decision.requested", subject_id="d1", **body):
    return ReceiptDraft(
        project_id="p", workspace_id="w", event=event, subject_type="decision",
        subject_id=subject_id, actor="alice", body=body or {"kind": "plan_approval"},
    )


def _chain(n: int):
    out, previous = [], None
    for i in range(n):
        previous = seal(_draft(subject_id=f"d{i}"), previous)
        out.append(previous)
    return out


def test_the_first_receipt_links_to_genesis_and_counts_from_one():
    r = seal(_draft(), None)
    assert r.seq == 1
    assert r.prev_hash == GENESIS == "0" * 64
    assert r.hash == receipt_hash(r) and len(r.hash) == 64


def test_each_receipt_links_to_the_one_before():
    a, b, c = _chain(3)
    assert (b.seq, b.prev_hash) == (2, a.hash)
    assert (c.seq, c.prev_hash) == (3, b.hash)


def test_an_intact_chain_verifies():
    chain = _chain(3)
    check = verify_chain(chain)
    assert check.ok and check.count == 3 and check.head == chain[-1].hash
    assert check.broken_at is None and check.reason is None


def test_an_empty_chain_verifies():
    check = verify_chain([])
    assert check.ok and check.count == 0 and check.head is None


def test_an_edited_body_breaks_the_chain_at_that_receipt():
    chain = _chain(3)
    chain[1] = chain[1].model_copy(update={"body": {"kind": "intent_approval"}})
    check = verify_chain(chain)
    assert not check.ok and check.broken_at == 2 and check.reason == "hash_mismatch"


def test_a_removed_receipt_breaks_the_chain():
    a, _, c = _chain(3)
    check = verify_chain([a, c])
    assert not check.ok and check.broken_at == 2 and check.reason == "seq_gap"


def test_a_rehashed_forgery_still_breaks_the_link():
    chain = _chain(3)
    forged = chain[1].model_copy(update={"actor": "mallory"})
    chain[1] = forged.model_copy(update={"hash": receipt_hash(forged)})
    check = verify_chain(chain)
    assert not check.ok and check.broken_at == 3 and check.reason == "prev_hash_mismatch"


def test_stamp_is_utc_with_microseconds_whatever_the_input_zone():
    bangkok = datetime(2026, 10, 14, 19, 0, 0, tzinfo=timezone.utc).astimezone()
    assert stamp(bangkok) == "2026-10-14T19:00:00.000000+00:00"


def test_the_hash_ignores_dict_key_order():
    r = seal(_draft(a="1", b="2"), None)
    reordered = r.model_copy(update={"body": {"b": "2", "a": "1"}})
    assert receipt_hash(reordered) == r.hash
