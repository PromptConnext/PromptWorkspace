"""plan_changes: from parsed phases to DeliveryChange rows (plan 0029 M1).
Pure: no repository, so regeneration behaviour is pinned exactly."""

from __future__ import annotations

from app.delivery.changes import plan_changes, wave_of
from app.generation.parsing import parse_task_phases

DOC = """
## Phase 1: Setup
- [ ] T001 a
## Phase 2: Foundational
- [ ] T002 b
## Phase 3: User Story 1 - Book (Priority: P1)
- [ ] T003 c
## Phase 4: User Story 2 - Remind (Priority: P2)
- [ ] T004 d
## Phase 5: Polish
- [ ] T005 e
"""


def _plan(doc=DOC, existing=None):
    return plan_changes("p1", "w1", parse_task_phases(doc), existing or [])


def test_first_plan_numbers_changes_in_document_order():
    plan = _plan()

    live = [c for c in plan.changes if c.deleted_at is None]
    assert [(c.ref, c.key, c.position) for c in live] == [
        ("C1", "setup", 0),
        ("C2", "foundational", 1),
        ("C3", "story:1", 2),
        ("C4", "story:2", 3),
        ("C5", "polish", 4),
    ]
    assert plan.change_key_of_ref == {
        "T1": "setup",
        "T2": "foundational",
        "T3": "story:1",
        "T4": "story:2",
        "T5": "polish",
    }


def test_dependencies_follow_rank_waves():
    by_key = {c.key: c for c in _plan().changes}

    assert by_key["setup"].depends_on == []
    assert by_key["foundational"].depends_on == ["setup"]
    assert by_key["story:1"].depends_on == ["foundational"]
    assert by_key["story:2"].depends_on == ["foundational"]
    assert by_key["polish"].depends_on == ["story:1", "story:2"]
    assert wave_of(_plan().changes) == {
        "setup": 0,
        "foundational": 1,
        "story:1": 2,
        "story:2": 2,
        "polish": 3,
    }


def test_missing_rank_is_skipped_when_resolving_dependencies():
    doc = "## Phase 1: Setup\n- [ ] T001 a\n## Phase 2: User Story 1 - X\n- [ ] T002 b\n"

    by_key = {c.key: c for c in _plan(doc).changes}

    assert by_key["story:1"].depends_on == ["setup"]


def test_regeneration_keeps_ids_and_refs_and_retires_missing_phases():
    first = [c for c in _plan().changes if c.deleted_at is None]
    reordered = """
## Phase 1: Setup
- [ ] T001 a
## Phase 2: User Story 2 - Remind (Priority: P2)
- [ ] T004 d
## Phase 3: User Story 3 - Cancel (Priority: P3)
- [ ] T006 f
"""

    second = _plan(reordered, existing=first)

    by_key = {c.key: c for c in second.changes}
    old = {c.key: c for c in first}
    assert by_key["setup"].id == old["setup"].id and by_key["setup"].ref == "C1"
    assert by_key["story:2"].id == old["story:2"].id and by_key["story:2"].ref == "C4"
    assert by_key["story:2"].position == 1
    assert by_key["story:3"].ref == "C6"  # new: next number after the highest ever used
    for gone in ("foundational", "story:1", "polish"):
        assert by_key[gone].deleted_at is not None
        assert by_key[gone].id == old[gone].id


def test_a_retired_change_is_revived_with_its_old_ref():
    first = [c for c in _plan().changes if c.deleted_at is None]
    without_polish = DOC.split("## Phase 5")[0]
    second = _plan(without_polish, existing=first)
    retired = [c for c in second.changes if c.deleted_at is not None]

    third = _plan(DOC, existing=[c for c in second.changes])

    polish = {c.key: c for c in third.changes}["polish"]
    assert polish.deleted_at is None
    assert polish.ref == "C5"
    assert polish.id == retired[0].id


def test_already_retired_rows_are_not_rewritten():
    first = [c for c in _plan().changes if c.deleted_at is None]
    second = _plan(DOC.split("## Phase 5")[0], existing=first)

    third = _plan(DOC.split("## Phase 5")[0], existing=second.changes)

    assert "polish" not in {c.key for c in third.changes}
