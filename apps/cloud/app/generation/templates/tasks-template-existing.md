---

description: "Task list template for a change to an existing codebase"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), [codebase_baseline] and [repo_snapshot] in CONTEXT

**Tests**: Tests are OPTIONAL - only include them if the specification or the constitution asks for them.

**Organization**: Tasks are grouped by user story. The project already exists and runs: there is no setup phase, no foundational phase and no polish phase.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Name the exact file each task touches, taken from the file list in [repo_snapshot]. A file that does not exist yet is written `path/to/file.ext (new)`.

<!--
  ============================================================================
  IMPORTANT: The phases below are STRUCTURE for illustration only.

  The __SPECKIT_COMMAND_TASKS__ command MUST replace them with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - What [codebase_baseline] says is already built, partial or missing

  This is a change to an EXISTING codebase. Do NOT generate tasks that create the
  project structure, initialise the project, install or configure the frameworks it
  already uses, or build routing, authentication, logging, error handling,
  environment configuration or a database layer the baseline lists as implemented.
  Do NOT add a catch-all "Polish" phase.

  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Baseline gaps (ONLY if the baseline lists something a user story needs as missing)

**Purpose**: Close a specific gap named in [codebase_baseline] that a user story below cannot work without. Omit this whole phase when there is no such gap, and start numbering at the first user story.

- [ ] T001 [Gap] Add [the missing piece named in the baseline] in path/to/file.ext (new)

---

## Phase 2: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 (OPTIONAL - only if the specification or constitution asks for them)

- [ ] T002 [P] [US1] Test for [behaviour] in [the existing test location named in the baseline, or tests/path/test_file.ext (new)]

### Implementation for User Story 1

- [ ] T003 [US1] Change [existing behaviour] in path/to/existing-file.ext
- [ ] T004 [P] [US1] Add [new unit] in path/to/new-file.ext (new)

**Checkpoint**: User Story 1 works on its own

---

## Phase 3: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Implementation for User Story 2

- [ ] T005 [US2] Change [existing behaviour] in path/to/existing-file.ext

**Checkpoint**: User Stories 1 AND 2 both work independently

---

[Add more user story phases as needed, following the same pattern. Stop after the last user story: no Polish phase.]

---

## Dependencies & Execution Order

- A baseline-gaps phase, when present, comes first and blocks the stories that need it.
- User stories otherwise depend only on the existing code and may proceed in parallel; stories that edit the same file run in priority order.
- Within a story: tests (if any) before implementation, models before services, services before endpoints and screens.
