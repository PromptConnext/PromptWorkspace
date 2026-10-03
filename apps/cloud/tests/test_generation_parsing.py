"""Unit tests for app/generation/parsing.py's strip_template_scaffolding —
guards against a model echoing the driver template's own authoring
guidance (HTML comments, __SPECKIT_COMMAND_*__ marker lines) back into the
generated document instead of treating it as instructions to itself.
"""

from __future__ import annotations

from app.generation.parsing import (
    fix_template_placeholders,
    parse_task_lines,
    strip_template_scaffolding,
)


def test_strips_html_comment_blocks():
    doc = (
        "# Title\n\n"
        "<!--\n"
        "  ACTION REQUIRED: fill this in.\n"
        "-->\n"
        "## Section\n"
        "Body text.\n"
    )
    result = strip_template_scaffolding(doc)
    assert "ACTION REQUIRED" not in result
    assert "# Title" in result
    assert "## Section" in result
    assert "Body text." in result


def test_strips_speckit_command_marker_lines():
    doc = (
        "# Plan\n\n"
        "**Note**: This template is filled in by the `__SPECKIT_COMMAND_PLAN__` command.\n\n"
        "## Summary\n"
        "Real content here.\n"
    )
    result = strip_template_scaffolding(doc)
    assert "__SPECKIT_COMMAND_PLAN__" not in result
    assert "Note" not in result
    assert "## Summary" in result
    assert "Real content here." in result


def test_leaves_normal_content_untouched():
    doc = "# Title\n\nJust a normal document with no scaffolding.\n"
    assert strip_template_scaffolding(doc) == doc.strip()


# --- parse_task_lines: per-task acceptance criteria ----------------------------
def test_task_lines_collect_indented_ac_sub_bullets_onto_the_preceding_task():
    doc = (
        "# Tasks\n\n"
        "- [ ] T001 [P] Add the login endpoint\n"
        "  - AC: POST /login returns 200 and a session token for valid credentials\n"
        "  - AC: A wrong password returns 401 without revealing which field was wrong\n"
        "- [ ] T002 Persist sessions\n"
        "    * ac: A session survives a server restart\n"
        "\t- Acceptance: Expired sessions are rejected with 401\n"
    )

    parsed = parse_task_lines(doc)

    assert [t["ref"] for t in parsed] == ["T001", "T002"]
    assert parsed[0]["acceptance_criteria"] == [
        "POST /login returns 200 and a session token for valid credentials",
        "A wrong password returns 401 without revealing which field was wrong",
    ]
    assert parsed[1]["acceptance_criteria"] == [
        "A session survives a server restart",
        "Expired sessions are rejected with 401",
    ]


def test_task_lines_ignore_ac_before_any_task_and_non_ac_sub_bullets():
    doc = (
        "  - AC: An orphan criterion with no task above it\n"
        "- [ ] T001 Add the login endpoint\n"
        "  - Depends on the user table\n"
        "  - Files: app/api/login.py\n"
        "- [ ] T002 Persist sessions\n"
        "- AC: Not indented, so not a sub-bullet\n"
        "  - AC:   \n"
    )

    parsed = parse_task_lines(doc)

    assert parsed == [
        {
            "ref": "T001",
            "title": "Add the login endpoint",
            "parallel": False,
            "acceptance_criteria": [],
        },
        {"ref": "T002", "title": "Persist sessions", "parallel": False, "acceptance_criteria": []},
    ]


def _spec(branch: str, title: str = "Feature Specification: Task Tracker") -> str:
    return f"# {title}\n\n**Feature Branch**: `{branch}`\n**Created**: 2026-10-03\n"


def test_branch_hash_prefix_becomes_001():
    assert "`001-task-tracker`" in fix_template_placeholders(_spec("###-task-tracker"))


def test_bracket_branch_derived_from_h1():
    assert "`001-task-tracker`" in fix_template_placeholders(_spec("[###-feature-name]"))


def test_plan_branch_and_input_paths():
    doc = (
        "# Implementation Plan: Task Tracker\n\n**Branch**: `###-task-tracker` | **Date**: x\n"
        "**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`\n"
    )
    out = fix_template_placeholders(doc)
    assert "**Branch**: `001-task-tracker`" in out
    assert "/specs/001-task-tracker/spec.md" in out


def test_good_branch_untouched():
    doc = _spec("001-task-tracker")
    assert fix_template_placeholders(doc) == doc


def test_bracket_branch_without_title_left_alone():
    doc = "# Feature Specification: [FEATURE NAME]\n\n**Feature Branch**: `[###-feature-name]`\n"
    assert fix_template_placeholders(doc) == doc


def test_feature_name_placeholder_replaced_in_body():
    out = fix_template_placeholders(_spec("001-x") + "\nBuild [FEATURE NAME] now.\n")
    assert "Build Task Tracker now." in out


def test_unambiguous_markers_untouched():
    body = (
        "- FR-1: [NEEDS CLARIFICATION: auth?]\n- [P] item [US1]\n"
        "See [docs](http://x) and $ARGUMENTS and [DATE]\n"
    )
    doc = _spec("001-x") + body
    assert fix_template_placeholders(doc) == doc


def test_tasks_lines_unaffected():
    doc = "# Tasks: Task Tracker\n\n- [ ] T001 [P] [US1] Create model in src/a.py\n"
    assert fix_template_placeholders(doc) == doc
