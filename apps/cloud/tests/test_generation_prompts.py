"""driver_prompt asks the tasks stage for per-task acceptance criteria, in the
`  - AC: ...` sub-bullet shape parse_task_lines reads, and no other stage."""

from __future__ import annotations

from app.generation.prompts import CURRENT_SERVICES_RULE, driver_prompt


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
