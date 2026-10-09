"""driver_prompt asks the tasks stage for per-task acceptance criteria, in the
`  - AC: ...` sub-bullet shape parse_task_lines reads, and no other stage."""

from __future__ import annotations

from app.generation.prefill import PREFILL_JOURNEYS_RULE
from app.generation.prefill import SYSTEM_PROMPT as PREFILL_SYSTEM_PROMPT
from app.generation.prompts import (
    BASELINE_EVIDENCE_RULE,
    CONSTITUTION_STRENGTH_RULE,
    CURRENT_SERVICES_RULE,
    EXISTING_CODEBASE_TASK_RULES,
    NO_CI_FIRST_TASK_RULE,
    PLAN_AUTHOR_OVERRIDE_RULE,
    codebase_baseline_prompt,
    driver_prompt,
)


def test_tasks_prompt_asks_for_ac_sub_bullets():
    prompt = driver_prompt("tasks")
    assert "  - AC: " in prompt
    assert "acceptance scenarios" in prompt


def test_other_stages_do_not_mention_ac_sub_bullets():
    for kind in ("constitution", "specify", "plan"):
        assert "- AC: " not in driver_prompt(kind)


def test_plan_and_tasks_prompts_carry_the_current_services_rule():
    for kind in ("plan", "tasks"):
        assert CURRENT_SERVICES_RULE in driver_prompt(kind)
        assert CURRENT_SERVICES_RULE in driver_prompt(kind, existing_codebase=True)


def test_constitution_and_specify_prompts_omit_the_current_services_rule():
    for kind in ("constitution", "specify"):
        assert CURRENT_SERVICES_RULE not in driver_prompt(kind)


def test_current_services_rule_stays_clear_of_non_imported_prompt_markers():
    for word in ("SECURITY", "re-scaffold", "Current State"):
        assert word not in CURRENT_SERVICES_RULE


def test_tasks_for_an_imported_project_use_the_brownfield_template():
    greenfield = driver_prompt("tasks")
    brownfield = driver_prompt("tasks", existing_codebase=True)

    # The greenfield skeleton is what made the model re-scaffold a working app.
    assert "Create project structure per implementation plan" in greenfield
    assert "Create project structure per implementation plan" not in brownfield
    assert "Phase 2: Foundational" not in brownfield
    assert "Polish & Cross-Cutting" not in brownfield
    assert "Baseline gaps" in brownfield
    for rule in EXISTING_CODEBASE_TASK_RULES:
        assert rule in brownfield
        assert rule not in greenfield


def test_the_brownfield_rules_name_the_failure_modes():
    text = " ".join(EXISTING_CODEBASE_TASK_RULES)
    for needle in ("(new)", "[repo_snapshot]", ".env.local", "out-of-scope", "Baseline gaps"):
        assert needle in text


def test_the_other_stages_do_not_change_for_an_imported_project():
    for kind in ("constitution", "specify", "plan"):
        assert EXISTING_CODEBASE_TASK_RULES[0] not in driver_prompt(kind, existing_codebase=True)


# --- prompt-quality batch (task 4.3) ------------------------------------------


def test_the_baseline_prompt_asks_each_implemented_claim_to_cite_its_file():
    """#5, #7: the baseline said IndexedDB where store.tsx uses localStorage,
    and the spec trusted it."""
    prompt = codebase_baseline_prompt()
    assert BASELINE_EVIDENCE_RULE in prompt
    assert "(src/lib/store.tsx)" in BASELINE_EVIDENCE_RULE
    for mechanism in ("localStorage", "IndexedDB", "in-memory"):
        assert mechanism in BASELINE_EVIDENCE_RULE
    # The template's own example bullet uses the same citation shape.
    assert "(src/server.js, src/routes/stories.js)" in prompt


def test_the_plan_prompt_lets_the_authors_fields_override_the_spec_and_baseline():
    """#16: an author's correction in the plan fields did not beat the spec."""
    for existing in (False, True):
        assert PLAN_AUTHOR_OVERRIDE_RULE in driver_prompt("plan", existing_codebase=existing)
    for kind in ("constitution", "specify", "tasks"):
        assert PLAN_AUTHOR_OVERRIDE_RULE not in driver_prompt(kind, existing_codebase=True)
    assert "Summary" in PLAN_AUTHOR_OVERRIDE_RULE


def test_the_constitution_prompt_marks_nothing_non_negotiable_unless_the_author_does():
    """#15: "Test-First (NON-NEGOTIABLE)" came from the template's example."""
    assert CONSTITUTION_STRENGTH_RULE in driver_prompt("constitution")
    assert CONSTITUTION_STRENGTH_RULE in driver_prompt("constitution", existing_codebase=True)
    for kind in ("specify", "plan", "tasks"):
        assert CONSTITUTION_STRENGTH_RULE not in driver_prompt(kind)
    assert "NON-NEGOTIABLE" in CONSTITUTION_STRENGTH_RULE


def test_the_prefill_prompt_drafts_journeys_only_from_the_prds_goals():
    """#8: the draft invented a journey and dropped two of the PRD's goals."""
    assert PREFILL_JOURNEYS_RULE in PREFILL_SYSTEM_PROMPT
    assert "every goal" in PREFILL_JOURNEYS_RULE


def test_brownfield_tasks_start_by_confirming_the_build_when_there_is_no_ci_or_tests():
    """#33: the shipped repository did not install, and nothing checked."""
    assert NO_CI_FIRST_TASK_RULE in EXISTING_CODEBASE_TASK_RULES
    assert NO_CI_FIRST_TASK_RULE in driver_prompt("tasks", existing_codebase=True)
    assert NO_CI_FIRST_TASK_RULE not in driver_prompt("tasks")
    for needle in ("install", "lint", "build", "record the result"):
        assert needle in NO_CI_FIRST_TASK_RULE


def test_brownfield_tasks_extend_an_env_template_the_file_list_already_shows():
    """#56: T025 "Add .env.example" for a repository that has one."""
    text = " ".join(EXISTING_CODEBASE_TASK_RULES)
    assert "already lists `.env.example`" in text
