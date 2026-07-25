"""Unit tests for the pure field-level merge engine (M3)."""

from __future__ import annotations

from datetime import timedelta

from app.db.merge import merge_entity
from app.models.schemas import FIELD_AUTHORITY, utcnow

TASK_AUTH = FIELD_AUTHORITY["tasks"]


def _row(**kw) -> dict:
    base = {"id": "t1", "project_id": "p1", "title": "T", "status": "todo"}
    base.update(kw)
    return base


def test_first_write_stamps_field_versions():
    now = utcnow()
    merged, dropped = merge_entity(None, _row(status="in_progress"), TASK_AUTH, "pz", now)
    assert merged["status"] == "in_progress"
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert merged["updated_at"] == now.isoformat()
    assert dropped == []


def test_pmo_cannot_clobber_pz_field():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="in_progress"), TASK_AUTH, "pz", t0)

    # A pmo writer tries to change status (a pz field) — rejected.
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(status="verified"), TASK_AUTH, "pmo", t1)
    assert merged["status"] == "in_progress"  # untouched
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert dropped == ["status"]


def test_pz_cannot_clobber_pmo_field():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(assignee="alice"), TASK_AUTH, "pmo", t0)

    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(assignee="bob"), TASK_AUTH, "pz", t1)
    assert merged["assignee"] == "alice"  # pz may not own assignee
    assert dropped == ["assignee"]


def test_concurrent_edits_to_different_fields_both_survive():
    # This is the case row-level LWW silently dropped.
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(), TASK_AUTH, "pz", t0)

    # pz sets status; pmo sets assignee — neither should erase the other.
    t1 = t0 + timedelta(seconds=1)
    stored, _ = merge_entity(stored, _row(status="in_progress"), TASK_AUTH, "pz", t1)
    t2 = t0 + timedelta(seconds=2)
    merged, dropped = merge_entity(stored, _row(assignee="alice"), TASK_AUTH, "pmo", t2)

    assert merged["status"] == "in_progress"
    assert merged["assignee"] == "alice"


def test_same_field_within_domain_newer_wins():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="todo"), TASK_AUTH, "pz", t0)
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(status="verified"), TASK_AUTH, "pz", t1)
    assert merged["status"] == "verified"
    assert dropped == []


def test_stale_same_domain_write_is_ignored():
    # A write whose field version is older than the stored one loses.
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="verified"), TASK_AUTH, "pz", t0)
    # Simulate an older field clock on the stored row so the incoming (at t_old)
    # is not newer.
    older = t0 - timedelta(seconds=10)
    merged, dropped = merge_entity(stored, _row(status="todo"), TASK_AUTH, "pz", older)
    assert merged["status"] == "verified"  # stale write rejected
    assert "status" in dropped


def test_shared_field_falls_back_to_lww_for_either_source():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(title="Original"), TASK_AUTH, "pz", t0)
    # title is "shared": a pmo writer may update it (LWW).
    t1 = t0 + timedelta(seconds=5)
    merged, dropped = merge_entity(stored, _row(title="From Jira"), TASK_AUTH, "pmo", t1)
    assert merged["title"] == "From Jira"
    assert "title" not in dropped


def test_backfilled_row_without_field_versions_behaves_as_lww():
    # A legacy row (no field_versions) accepts the first field-scoped write.
    t0 = utcnow()
    legacy = _row(status="todo")  # no field_versions key
    merged, dropped = merge_entity(legacy, _row(status="in_progress"), TASK_AUTH, "pz", t0)
    assert merged["status"] == "in_progress"
    assert merged["field_versions"]["status"]["source"] == "pz"
    assert dropped == []


def test_deleted_at_is_row_level_not_gated():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(), TASK_AUTH, "pz", t0)
    # Either side can tombstone; deleted_at is a row-level signal.
    t1 = t0 + timedelta(seconds=1)
    tombstone_ts = t1.isoformat()
    merged, dropped = merge_entity(
        stored, _row(deleted_at=tombstone_ts), TASK_AUTH, "pmo", t1
    )
    assert merged["deleted_at"] == tombstone_ts
    assert "deleted_at" not in dropped  # tombstone is never gated/dropped


# --------------------------------------------------------------------------- #
# WP2 — dropped-field reporting (conflict visibility)
# --------------------------------------------------------------------------- #
def test_dropped_lists_ownership_gate_rejections():
    t0 = utcnow()
    stored, _ = merge_entity(
        None, _row(status="in_progress", acceptance_criteria=[]), TASK_AUTH, "pz", t0
    )
    t1 = t0 + timedelta(seconds=5)
    # pmo writer tries to touch two pz fields at once; both are gated. Use a
    # bare incoming dict (not the _row helper) so only the fields under test
    # are present — _row's baked-in "title"/"status" defaults would otherwise
    # leak unrelated (non-)conflicts into the assertion.
    _, dropped = merge_entity(
        stored,
        {"id": "t1", "status": "verified", "acceptance_criteria": [{"text": "new"}]},
        TASK_AUTH,
        "pmo",
        t1,
    )
    assert sorted(dropped) == ["acceptance_criteria", "status"]


def test_dropped_lists_stale_lww_rejections():
    t0 = utcnow()
    stored, _ = merge_entity(None, _row(status="verified"), TASK_AUTH, "pz", t0)
    older = t0 - timedelta(seconds=10)
    # Bare incoming dict with only "status" so the always-present "title"
    # default in _row doesn't also show up as a (correctly) dropped field.
    _, dropped = merge_entity(stored, {"id": "t1", "status": "todo"}, TASK_AUTH, "pz", older)
    assert dropped == ["status"]


def test_dropped_empty_on_clean_first_write():
    now = utcnow()
    _, dropped = merge_entity(None, _row(status="todo"), TASK_AUTH, "pz", now)
    assert dropped == []
