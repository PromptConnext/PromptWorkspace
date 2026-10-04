"""parse_task_phases: grouping tasks.md checklist lines by their `## Phase N:`
heading (plan 0029 M1). The model is asked to keep the template's headings but
nothing guarantees their exact punctuation, so the parser is deliberately
forgiving about separators and strict only about what a phase *is*."""

from __future__ import annotations

from app.generation.parsing import TaskPhase, parse_task_phases

TEMPLATE_SHAPED = """# Tasks: Clinic booking

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create the Next.js project
- [ ] T002 [P] Configure linting

---

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Create the patients table
  - AC: A patient row stores an encrypted phone number

## Phase 3: User Story 1 - Book a slot (Priority: P1) 🎯 MVP

### Tests for User Story 1

- [ ] T004 [P] [US1] Contract test for POST /bookings

### Implementation for User Story 1

- [ ] T005 [US1] Implement POST /bookings

## Phase 4: User Story 2 - Get a reminder (Priority: P2)

- [ ] T006 [US2] Send the reminder SMS

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T007 Write the README

## Dependencies & Execution Order

Setup first, then foundational, then stories.
"""


def test_template_shaped_document_groups_tasks_by_phase():
    phases = parse_task_phases(TEMPLATE_SHAPED)

    assert [p.key for p in phases] == [
        "setup",
        "foundational",
        "story:1",
        "story:2",
        "polish",
    ]
    assert phases[0] == TaskPhase(
        key="setup",
        title="Setup (Shared Infrastructure)",
        kind="setup",
        story=None,
        priority=None,
        refs=("T001", "T002"),
    )
    assert phases[2].kind == "story"
    assert phases[2].story == 1
    assert phases[2].priority == "P1"
    assert phases[2].title == "User Story 1 - Book a slot"
    # `###` sub-headings stay inside their `##` phase.
    assert phases[2].refs == ("T004", "T005")
    assert phases[3].refs == ("T006",)
    assert phases[4].kind == "polish"


def test_flat_checklist_without_headings_is_one_unphased_phase():
    doc = "# Tasks\n\n- [ ] T001 Do one thing\n- [ ] T002 Do another\n"

    phases = parse_task_phases(doc)

    assert phases == [
        TaskPhase(
            key="unphased",
            title="Unphased tasks",
            kind="unphased",
            story=None,
            priority=None,
            refs=("T001", "T002"),
        )
    ]


def test_heading_separators_are_forgiving():
    doc = (
        "## Phase 1 — Setup\n- [ ] T001 a\n"
        "## Phase 2 - Foundational\n- [ ] T002 b\n"
        "## phase 3: user story 2 – Search (priority: p2)\n- [ ] T003 c\n"
        "## Phase N: Polish\n- [ ] T004 d\n"
    )

    phases = parse_task_phases(doc)

    assert [(p.key, p.priority) for p in phases] == [
        ("setup", None),
        ("foundational", None),
        ("story:2", "P2"),
        ("polish", None),
    ]


def test_unknown_phase_titles_become_other_with_a_slug_key():
    doc = "## Phase 3: Data Migration & Backfill\n- [ ] T010 Backfill rows\n"

    (phase,) = parse_task_phases(doc)

    assert phase.kind == "other"
    assert phase.key == "phase:data-migration-backfill"


def test_tasks_after_a_non_phase_heading_fall_back_to_unphased():
    doc = (
        "## Phase 1: Setup\n- [ ] T001 a\n"
        "## Notes\n- [ ] T099 stray task under notes\n"
    )

    phases = parse_task_phases(doc)

    assert [(p.key, p.refs) for p in phases] == [("setup", ("T001",)), ("unphased", ("T099",))]


def test_repeated_phase_key_merges_into_the_first_phase():
    doc = (
        "## Phase 1: Setup\n- [ ] T001 a\n"
        "## Phase 2: Setup again\n- [ ] T002 b\n"
    )

    (phase,) = parse_task_phases(doc)

    assert phase.refs == ("T001", "T002")


def test_thai_phase_titles_survive_and_stay_distinct():
    doc = (
        "## Phase 3: ย้ายข้อมูลลูกค้า\n- [ ] T010 a\n"
        "## Phase 4: ตรวจสอบรายงาน\n- [ ] T011 b\n"
    )

    phases = parse_task_phases(doc)

    assert [p.title for p in phases] == ["ย้ายข้อมูลลูกค้า", "ตรวจสอบรายงาน"]
    assert phases[0].key != phases[1].key
    assert all(p.kind == "other" for p in phases)


def test_phases_without_tasks_are_dropped():
    doc = "## Phase 1: Setup\n\nnothing here\n\n## Phase 2: Foundational\n- [ ] T001 a\n"

    assert [p.key for p in parse_task_phases(doc)] == ["foundational"]
