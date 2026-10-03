"""Unit tests for app/generation/parsing.py's strip_template_scaffolding —
guards against a model echoing the driver template's own authoring
guidance (HTML comments, __SPECKIT_COMMAND_*__ marker lines) back into the
generated document instead of treating it as instructions to itself.
"""

from __future__ import annotations

from app.generation.parsing import parse_task_lines, strip_template_scaffolding


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
