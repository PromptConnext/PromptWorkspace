"""Hash-chained receipts (enterprise AI v2.1 D1, View 1 "Receipts").

Each project has one append-only chain. A receipt's hash is SHA-256 over the
canonical JSON of every other field, including the previous receipt's hash,
so editing, removing or reordering any receipt is detectable from the chain
alone. Pure functions; the store and the recording rules live elsewhere
(app/db, app/delivery/ledger.py).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone

from app.models.schemas import Receipt, ReceiptDraft, utcnow

GENESIS = "0" * 64


def stamp(at: datetime) -> str:
    """The one timestamp form a hash covers: UTC, microseconds, `+00:00`.
    Postgres timestamptz keeps microseconds, so a receipt read back from the
    store stamps to the same string it was sealed with. Naive datetimes are
    refused because their meaning depends on the host's zone."""
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("receipt timestamps must be timezone-aware")
    return at.astimezone(timezone.utc).isoformat(timespec="microseconds")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def receipt_hash(r: Receipt) -> str:
    payload = {
        "id": r.id,
        "project_id": r.project_id,
        "workspace_id": r.workspace_id,
        "seq": r.seq,
        "event": r.event,
        "subject_type": r.subject_type,
        "subject_id": r.subject_id,
        "actor": r.actor,
        "body": r.body,
        "prev_hash": r.prev_hash,
        "created_at": stamp(r.created_at),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return sha256_text(canonical)


def seal(draft: ReceiptDraft, previous: Receipt | None, *, at: datetime | None = None) -> Receipt:
    """`draft` as the next link after `previous` (None: the first link)."""
    receipt = Receipt(
        **draft.model_dump(),
        seq=previous.seq + 1 if previous else 1,
        prev_hash=previous.hash if previous else GENESIS,
        created_at=at or utcnow(),
    )
    return receipt.model_copy(update={"hash": receipt_hash(receipt)})


@dataclass(frozen=True)
class ChainCheck:
    ok: bool
    count: int
    head: str | None
    broken_at: int | None = None
    reason: str | None = None


def verify_chain(receipts: list[Receipt]) -> ChainCheck:
    """Check a whole chain, oldest first. `broken_at` is the `seq` position
    (1-based) of the first receipt that does not fit."""
    prev_hash = GENESIS
    for position, r in enumerate(receipts, start=1):
        if r.seq != position:
            return ChainCheck(False, len(receipts), None, position, "seq_gap")
        if r.prev_hash != prev_hash:
            return ChainCheck(False, len(receipts), None, position, "prev_hash_mismatch")
        if receipt_hash(r) != r.hash:
            return ChainCheck(False, len(receipts), None, position, "hash_mismatch")
        prev_hash = r.hash
    return ChainCheck(True, len(receipts), receipts[-1].hash if receipts else None)
