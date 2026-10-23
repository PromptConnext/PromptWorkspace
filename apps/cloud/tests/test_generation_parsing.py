"""Unit tests for app/generation/parsing.py's strip_template_scaffolding —
guards against a model echoing the driver template's own authoring
guidance (HTML comments, __SPECKIT_COMMAND_*__ marker lines) back into the
generated document instead of treating it as instructions to itself.
"""

from __future__ import annotations

import pytest

from app.generation.parsing import (
    fix_template_placeholders,
    missing_task_refs,
    parse_files,
    parse_task_lines,
    strip_spec_kit_boilerplate,
    strip_template_scaffolding,
    titles_match,
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


def test_bare_stage_title_h1_is_not_a_feature_name():
    doc = "# Implementation Plan\n\n**Branch**: `[###-feature-name]`\n"
    assert fix_template_placeholders(doc) == doc
    const = "# Project Constitution\n\nBuild [FEATURE] now.\n"
    assert fix_template_placeholders(const) == const


def test_h1_inside_code_fence_is_not_a_feature_name():
    doc = "Intro\n\n```bash\n# install deps\n```\n\n**Branch**: `[###-feature-name]`\n"
    assert fix_template_placeholders(doc) == doc


def test_feature_placeholder_untouched_inside_code_fence():
    doc = _spec("001-x") + "\nUse [FEATURE] here.\n\n```\nrun [FEATURE NAME]\n```\n"
    out = fix_template_placeholders(doc)
    assert "run [FEATURE NAME]" in out
    assert "Use [FEATURE] here." not in out


# --- titles_match (task 4.1, finding #57) -----------------------------------
# A regenerated task keeps its row (and a closed row its status) only when its
# title still describes the same work. Light rewording matches; different work
# does not, in either script.


@pytest.mark.parametrize(
    ("old", "new", "expected"),
    [
        # identical, and identical after case/space/punctuation normalisation
        ("Persist the payment record", "Persist the payment record", True),
        ("Persist the payment record", "  persist the Payment record. ", True),
        # light rewording keeps the task
        ("Persist the payment record", "Persist the payment ledger", True),
        (
            "[US1] Replace ASSET GROW in src/App.tsx",
            "[US1] Replace ASSET GROW in src/App.tsx and src/lib/exporters.ts",
            True,
        ),
        # different work under the same ref
        ("Add the payment intent endpoint", "Reconcile settlements nightly", False),
        ("Persist the payment record", "Replace ASSET GROW in src/App.tsx", False),
        # Thai has no spaces between words; similarity must still see it
        ("เพิ่มหน้าตั้งค่าโปรไฟล์ผู้ใช้", "เพิ่มหน้าตั้งค่าโปรไฟล์ของผู้ใช้", True),
        ("เพิ่มหน้าตั้งค่าโปรไฟล์ผู้ใช้", "แก้ไขการส่งออกรายงานยอดขาย", False),
        ("[US2] เปลี่ยนชื่อแบรนด์ใน src/App.tsx", "[US2] เปลี่ยนชื่อแบรนด์ใน src/App.tsx ทั้งหมด", True),
        # adding the files the work touches is not different work (review of 4.1)
        (
            "Replace ASSET GROW branding",
            "Replace ASSET GROW branding in `src/App.tsx`, `src/lib/exporters.ts` and "
            "`index.html`",
            True,
        ),
        ("Create user model", "Create the User model in src/models/user.ts", True),
        # ...and different work naming the same files is still different work
        (
            "Add the payment intent endpoint in `src/api/payments.ts`",
            "Reconcile settlements nightly in `src/api/payments.ts`",
            False,
        ),
        # ...a path without backticks counts as a path only with a slash and an extension
        ("Create user model", "Create user model in src/models/user.ts and src/db/user.sql", True),
        # a dotted technology name or a slash phrase is a word, not a path (review of 2609900)
        ("Switch to Socket.io", "Switch to Express.js", False),
        ("Rewrite in Rust.rs", "Rewrite in Go.go", False),
        ("Add Socket.io server", "Add Express.js server", False),
        ("Set up CI/CD", "Set up client/server split", False),
        # other scripts are compared too, not reduced to nothing
        ("Добавить экспорт отчётов", "Добавить экспорт всех отчётов", True),
        ("Добавить экспорт отчётов", "Исправить вход пользователя", False),
        ("添加用户导出功能", "添加用户数据导出功能", True),
        ("添加用户导出功能", "修复登录页面错误", False),
        # empty titles are only the same as each other
        ("", "", True),
        ("", "Persist the payment record", False),
    ],
)
def test_titles_match(old: str, new: str, expected: bool):
    assert titles_match(old, new) is expected
    # symmetric: which generation came first does not change the answer
    assert titles_match(new, old) is expected


def test_parse_files_keeps_inner_fences():
    raw = (
        "```file:plan.md\n# Plan\n\n### Documentation\n\n```text\nspecs/\n```\n\n"
        "## After\nmore\n```\n"
    )
    files = parse_files(raw)
    assert len(files) == 1
    assert files[0]["content"].endswith("## After\nmore\n")
    assert "```text\nspecs/\n```" in files[0]["content"]


def test_parse_files_two_blocks_each_with_inner_fence():
    raw = (
        "```file:a.md\n# A\n```bash\nls\n```\nend A\n```\n"
        "```file:b.md\n# B\n```text\nx\n```\nend B\n```\n"
    )
    files = parse_files(raw)
    assert [f["path"] for f in files] == ["a.md", "b.md"]
    assert files[0]["content"].endswith("end A\n")
    assert files[1]["content"].endswith("end B\n")


def test_parse_files_closing_fence_on_content_line():
    assert parse_files("```file:p.md\n# Plan\nlast line```\n") == [
        {"path": "p.md", "content": "# Plan\nlast line\n"}
    ]


def test_parse_files_unclosed_inner_fence_is_salvaged():
    files = parse_files("```file:plan.md\n# Plan\n```text\nx\n\n## After\nmore\n```\n")
    assert len(files) == 1
    assert files[0]["content"].startswith("# Plan\n")
    assert "## After\nmore" in files[0]["content"]


def test_parse_files_new_opener_ends_unclosed_block():
    raw = "```file:a.md\n# A\n```text\nx\n```file:b.md\n# B\nend\n```\n"
    files = parse_files(raw)
    assert [f["path"] for f in files] == ["a.md", "b.md"]
    assert files[0]["content"] == "# A\n```text\nx\n"
    assert files[1]["content"] == "# B\nend\n"


def test_parse_files_unterminated_block_kept_at_eof():
    assert parse_files("```file:a.md\n# A\nbody") == [
        {"path": "a.md", "content": "# A\nbody\n"}
    ]


def test_parse_files_drops_unsafe_paths():
    raw = (
        "```file:../evil.md\nx\n```\n```file:/abs.md\ny\n```\n"
        "```file:ok.md\nz\n```\n"
    )
    assert [f["path"] for f in parse_files(raw)] == ["ok.md"]


def test_parse_files_indented_inner_fence_stays_inside_block():
    raw = "```file:a.md\n# A\n1. step\n   ```bash\n   ls\n   ```\nafter\n```\n"
    files = parse_files(raw)
    assert len(files) == 1
    assert files[0]["content"].endswith("after\n")
    assert "   ```bash\n   ls\n   ```\n" in files[0]["content"]


def test_strip_spec_kit_boilerplate_removes_scaffolding():
    doc = (
        "# Tasks: Ledger\n\n"
        "**Feature Branch**: `001-ledger`\n"
        "**Input**: Design documents from `/specs/001-ledger/`\n"
        "**Prerequisites**: plan.md (required), research.md\n"
        "**Tests**: Tests are OPTIONAL - only include them if requested.\n\n"
        "## Requirements\n\n"
        "- **FR-001**: System MUST record entries\n\n"
        "*Example of marking unclear requirements:*\n\n"
        "- **FR-006**: System MUST authenticate users via "
        "[NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]\n"
        "- **FR-007**: System MUST retain user data for "
        "[NEEDS CLARIFICATION: retention period not specified]\n\n"
        "Use [GUIDANCE_FILE] for runtime guidance.\n"
        "Done when it matches `/specs/001-ledger/spec.md` and /specs/001-ledger/plan.md.\n"
        "See specs/001-ledger/tasks.md.\n\n"
        "```text\n/specs/x\n```\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert not any(ln.startswith("**Feature Branch**:") for ln in out.split("\n"))
    assert "Example of marking unclear requirements" not in out
    assert "FR-006" not in out and "FR-007" not in out
    assert "**FR-001**" in out
    assert "[GUIDANCE_FILE]" not in out
    assert "**Input**:" not in out and "**Prerequisites**:" not in out
    assert "Tests are OPTIONAL" not in out
    assert "the specification" in out and "the plan" in out and "the task list" in out
    out_outside = out.split("```text")[0]
    assert "/specs/" not in out_outside and "specs/001" not in out_outside
    assert "```text\n/specs/x\n```" in out


def test_strip_spec_kit_boilerplate_keeps_real_requirements_after_the_example_line():
    doc = (
        "## Requirements\n\n"
        "*Example of marking unclear requirements:*\n\n"
        "- **FR-006**: System MUST notify users [NEEDS CLARIFICATION: which channel?]\n"
        "- **FR-007**: System MUST export reports\n\n"
        "## Success\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "Example of marking" not in out
    assert "- **FR-006**: System MUST notify users [NEEDS CLARIFICATION: which channel?]" in out
    assert "- **FR-007**: System MUST export reports\n\n## Success" in out


@pytest.mark.parametrize(
    "line",
    [
        "- [ ]  T029 x",
        "- [ ] **T029** x",
        "- [ ] T029: x",
        "* [x] T029 [P] [US3] x",
        "- [ ] **T029:** x",
    ],
)
def test_parse_task_lines_accepts_variants(line: str):
    tasks = parse_task_lines(line)
    assert [t["ref"] for t in tasks] == ["T029"]


def test_missing_task_refs():
    assert missing_task_refs(["T001", "T002", "T004"]) == ["T003"]
    assert missing_task_refs([]) == []
    assert missing_task_refs(["T001", "T002", "T003"]) == []


def test_missing_task_refs_pads_like_the_widest_ref():
    assert missing_task_refs(["T1", "T2", "T4"]) == ["T3"]
    refs = [f"T{n:03d}" for n in range(1, 36) if n != 29]
    assert missing_task_refs(refs) == ["T029"]


def test_missing_task_refs_is_capped_at_fifty():
    assert len(missing_task_refs(["T001", "T900"])) == 50


def test_missing_task_refs_ignores_a_wildly_sparse_list():
    assert missing_task_refs(["T1", "T99999999"]) == []
    assert missing_task_refs(["T0001", "T1002"]) == []
    assert len(missing_task_refs(["T0001", "T1000"])) == 50


def test_drops_option_labels_inside_the_project_tree_fence():
    doc = (
        "## Project Structure\n\n"
        "```text\n"
        '# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)\n'
        "backend/\n"
        "# comment\n"
        "```"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "backend/" in out
    assert "# comment" in out
    assert "Option 2:" not in out


def test_drops_branch_and_spec_header_line():
    doc = (
        "# Implementation Plan: Clinic\n\n"
        "**Branch**: `001-clinic` | **Date**: 2026-10-18 | "
        "**Spec**: https://example.com/specs/001\n\n"
        "## Summary\n\n"
        "**Branch**: `keep-me`\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "example.com" not in out
    assert "`001-clinic`" not in out
    assert "**Branch**: `keep-me`" in out


def test_drops_fill_only_if_note():
    doc = (
        "## Complexity Tracking\n\n"
        "> **Fill ONLY if Constitution Check has violations that must be justified**\n\n"
        "| Violation | Why |\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "Fill ONLY" not in out
    assert "| Violation | Why |" in out


def test_drops_path_conventions_section():
    doc = (
        "## Format\n\nText.\n\n"
        "## Path Conventions\n\n"
        "- **Single project**: `src/`, `tests/` at repository root\n"
        "- **Web app**: `backend/src/`, `frontend/src/`\n"
        "- **Mobile**: `api/src/`, `ios/src/` or `android/src/`\n"
        "- Paths shown below assume single project\n\n"
        "## Phase 1: Setup\n\nWork.\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "Path Conventions" not in out
    assert "Single project" not in out
    assert "assume single project" not in out
    assert "## Phase 1: Setup" in out
    assert "## Format" in out


def test_unwraps_optional_tests_heading():
    doc = "### Tests for User Story 2 (OPTIONAL - only if tests requested) ⚠️\n\n- [ ] T001 x"
    out = strip_spec_kit_boilerplate(doc)
    assert out.startswith("### Tests for User Story 2\n")
    assert "OPTIONAL" not in out


def test_drops_parallel_example_section():
    doc = (
        "## Notes\n\nKeep.\n\n"
        "## Parallel Example: User Story 1\n\n"
        "```bash\n"
        "# Launch all tests\n"
        '## not a heading inside fence\n'
        'Task: "Contract test"\n'
        "```\n\n"
        "Trailing prose.\n\n"
        "## Implementation Strategy\n\nGo.\n"
    )
    out = strip_spec_kit_boilerplate(doc)
    assert "Parallel Example" not in out
    assert "Launch all tests" not in out
    assert "Trailing prose" not in out
    assert "Keep." in out
    assert "## Implementation Strategy" in out
