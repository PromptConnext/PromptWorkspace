"""Which receipts the decision layer writes, and how (enterprise AI v2.1 D1).

Decision receipts are derived from the decision rows: `expected_events` says
which receipts a decision in its current state implies, and
`sync_decision_receipts` appends the ones the chain does not have yet. A
receipt write that fails (crash, lost race, store down) is therefore repaired
by the next decision write in the same project instead of being lost. Hat
changes and snapshot erasures are not derivable from a row, so they use
`append_receipt` directly.
"""

from __future__ import annotations

import logging
from datetime import datetime

from app.db.repository import DeliveryStoreUnavailable, ReceiptConflict, Repository
from app.delivery.receipts import seal, sha256_text, stamp
from app.models.schemas import Decision, Receipt, ReceiptDraft

logger = logging.getLogger("promptworkspace.receipts")

# Ties on the same timestamp: a request is recorded before its outcome.
_RANK = {"decision.requested": 0}


def expected_events(decision: Decision) -> list[tuple[datetime, ReceiptDraft]]:
    def draft(event: str, actor: str, at: datetime, **extra) -> tuple[datetime, ReceiptDraft]:
        body: dict[str, str | int | bool | None] = {
            "kind": decision.kind,
            "subject_stage": decision.subject_stage,
            "subject_hash": decision.subject_hash,
            "routed_hat": decision.routed_hat,
            "occurred_at": stamp(at),
            **extra,
        }
        return at, ReceiptDraft(
            project_id=decision.project_id, workspace_id=decision.workspace_id,
            event=event, subject_type="decision", subject_id=decision.id,
            actor=actor, body=body,
        )

    events = [draft("decision.requested", decision.requested_by, decision.created_at)]
    resolved_at = decision.resolved_at or decision.created_at
    if decision.status in ("approved", "rejected"):
        rationale = (
            {"rationale_sha256": sha256_text(decision.rationale)} if decision.rationale else {}
        )
        events.append(draft(f"decision.{decision.status}", decision.resolved_by or "system",
                            resolved_at, **rationale))
    elif decision.status == "withdrawn":
        events.append(draft("decision.withdrawn", decision.resolved_by or "system", resolved_at))
    elif decision.status == "expired":
        events.append(draft("decision.expired", "system", resolved_at))
    return events


def sync_decision_receipts(
    repo: Repository, project_id: str, decisions: list[Decision], *, attempts: int = 5
) -> int:
    written = 0
    for _ in range(attempts):
        try:
            chain = repo.list_receipts(project_id)
            have = {(r.subject_id, r.event) for r in chain if r.subject_type == "decision"}
            missing = sorted(
                (
                    (at, draft)
                    for d in decisions
                    for at, draft in expected_events(d)
                    if (draft.subject_id, draft.event) not in have
                ),
                key=lambda pair: (pair[0], _RANK.get(pair[1].event, 1)),
            )
            previous: Receipt | None = chain[-1] if chain else None
            for _, draft in missing:
                previous = repo.insert_receipt(seal(draft, previous))
                written += 1
            return written
        except ReceiptConflict:
            continue  # another writer extended the chain: re-read and seal again
        except DeliveryStoreUnavailable:
            logger.warning("receipt store unavailable, project=%s", project_id)
            return written
        except Exception:
            logger.exception("receipt sync failed, project=%s", project_id)
            return written
    logger.error("receipt sync lost %s races, project=%s", attempts, project_id)
    return written


def append_receipt(repo: Repository, draft: ReceiptDraft, *, attempts: int = 5) -> Receipt:
    for _ in range(attempts):
        chain = repo.list_receipts(draft.project_id)
        try:
            return repo.insert_receipt(seal(draft, chain[-1] if chain else None))
        except ReceiptConflict:
            continue
    raise ReceiptConflict(f"lost {attempts} races appending {draft.event}")
