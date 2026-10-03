"""driver_prompt asks the tasks stage for per-task acceptance criteria, in the
`  - AC: ...` sub-bullet shape parse_task_lines reads, and no other stage."""

from __future__ import annotations

from app.generation.prompts import driver_prompt


def test_tasks_prompt_asks_for_ac_sub_bullets():
    prompt = driver_prompt("tasks")
    assert "  - AC: " in prompt
    assert "acceptance scenarios" in prompt


def test_other_stages_do_not_mention_ac_sub_bullets():
    for kind in ("constitution", "specify", "plan"):
        assert "- AC: " not in driver_prompt(kind)
