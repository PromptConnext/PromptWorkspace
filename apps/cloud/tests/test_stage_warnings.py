"""The parse warnings shared by generation and agent stage drafts."""

from __future__ import annotations

from app.generation.warnings import stage_warnings
from app.models.schemas import RepoAnalysis, RepoSnapshot


def _analysis(paths: list[str]) -> RepoAnalysis:
    return RepoAnalysis(
        project_id="p1",
        workspace_id="w1",
        commit_sha="a" * 40,
        snapshot=RepoSnapshot(
            commit_sha="a" * 40, default_branch="main", file_count=len(paths), paths=paths
        ),
        baseline="# Baseline",
        status="baseline_ready",
        created_by="alice",
    )


def test_tasks_with_gaps_and_unknown_paths():
    markdown = "## Phase 1: X\n- [ ] T001 Change `src/a.js`\n- [ ] T003 Change `src/b.js`\n"
    warnings = stage_warnings("tasks", markdown, _analysis(["src/a.js"]))
    assert warnings == [
        {"code": "missing_task_numbers", "items": ["T002"]},
        {"code": "unmarked_new_paths", "items": [{"ref": "T003", "path": "src/b.js"}]},
    ]


def test_tasks_without_task_lines():
    assert stage_warnings("tasks", "# Tasks\n\nSoon.\n", None) == [
        {"code": "no_task_lines", "items": []}
    ]


def test_an_empty_document_for_any_stage():
    for stage in ("constitution", "specify", "plan", "tasks"):
        codes = [w["code"] for w in stage_warnings(stage, "   \n", None)]
        assert codes[0] == "empty_document"


def test_a_plain_specification_is_clean():
    assert stage_warnings("specify", "# Spec\n\nText.\n", None) == []
