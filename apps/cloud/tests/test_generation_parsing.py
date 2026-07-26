"""Unit tests for app/generation/parsing.py's strip_template_scaffolding —
guards against a model echoing the driver template's own authoring
guidance (HTML comments, __SPECKIT_COMMAND_*__ marker lines) back into the
generated document instead of treating it as instructions to itself.
"""

from __future__ import annotations

from app.generation.parsing import strip_template_scaffolding


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
