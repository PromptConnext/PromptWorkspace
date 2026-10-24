"""The hosted MCP server's planning tools: start_planning,
submit_repo_analysis and submit_stage_draft (design 2026-10-24, Task 9).

Driven through the SDK's streamable-HTTP client against the real ASGI app,
the way tests/test_mcp_server.py drives the task tools. The project is an
imported one, made through POST /projects with the fake GitHub client exactly
as tests/test_repo_analysis_api.py makes it."""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.api.stage_drafts import PlanningBriefOut
from app.integrations.github import FakeGithubClient
from app.mcp.tools_planning import render_brief, warning_lines
from app.models.schemas import StageDraftWarning
from tests import test_mcp_server as harness
from tests.test_mcp_server import _running, _session, _text, _token
from tests.test_repo_analysis_api import HEAD, _imported_project, _scratch_project

REPO_URL = "https://github.com/acme/storyapp"

# The Task 8 harness's fixtures: the anyio backend, and the app with /mcp
# enabled and a signing key minted per test.
anyio_backend = harness.anyio_backend
mcp_app = harness.mcp_app

ANALYSIS = {
    "default_branch": "main",
    "commit_sha": HEAD,
    "paths": ["README.md", "src/server.js"],
    "file_count": 2,
    "stack": {"runtime": "node", "manifests": ["package.json"], "languages": ["javascript"]},
    "tree_summary": "src/ 1",
    "baseline": "# Baseline\n\nExpress app.",
    "model": "claude-opus-5-5",
}


def _imported(app) -> str:
    """An imported project in alice's workspace (bob a member); its id."""
    app.state.github_client = FakeGithubClient()
    _, pid = _imported_project(TestClient(app))
    return pid


def _error(result) -> str:
    """A tool error's message, less the SDK's `Error executing tool <name>: `."""
    assert result.is_error, _text(result)
    return re.sub(r"^Error executing tool \w+: ", "", _text(result))


async def _call(app, user: str, tool: str, args: dict):
    repo = app.state.repository
    token, _ = _token(user=user, repo=repo)
    async with _session(app, token) as session:
        return await session.call_tool(tool, args)


@pytest.fixture
def app(mcp_app):
    return mcp_app


@pytest.mark.anyio
async def test_list_tools_returns_the_six_tools(app):
    async with _running(app) as repo:
        token, _ = _token(repo=repo)
        async with _session(app, token) as session:
            names = {t.name for t in (await session.list_tools()).tools}
    assert names == {
        "list_my_tasks", "get_task", "close_task",
        "start_planning", "submit_repo_analysis", "submit_stage_draft",
    }  # fmt: skip


@pytest.mark.anyio
async def test_start_planning_renders_every_section_in_order(app):
    async with _running(app):
        _imported(app)
        result = await _call(app, "alice", "start_planning", {"repo_url": REPO_URL})
    assert not result.is_error, _text(result)
    text = _text(result)
    lines = text.splitlines()
    sections = [
        "## Instructions", "## Project", "## Drafts", "## Baseline",
        "## Policy context", "## PRDs", "## Templates",
    ]  # fmt: skip
    assert lines[0] == "## Instructions"
    positions = [lines.index(heading) for heading in sections]
    assert positions == sorted(positions)
    instructions = text.split("\n## Project\n")[0]
    assert (
        "Read AGENTS.md, docs/conventions.md and .specify/memory/constitution.md from your "
        "clone before drafting; this server cannot see your files."
    ) in instructions
    assert "- name: Story App" in text
    assert f"- repo_url: {REPO_URL}" in text
    assert "- default_branch: main" in text
    assert "- can_submit_analysis: true" in text
    assert "- analysis_status: none" in text
    assert "- submittable_stages: constitution, specify, plan, tasks" in text
    templates = text.split("## Templates")[1]
    order = [templates.index(f"### {s}") for s in ("constitution", "specify", "plan", "tasks")]
    assert order == sorted(order)
    assert "```markdown\n" in templates


@pytest.mark.anyio
async def test_start_planning_for_a_member_by_id(app):
    async with _running(app):
        pid = _imported(app)
        result = await _call(app, "bob", "start_planning", {"project_id": pid})
    text = _text(result)
    assert not result.is_error, text
    assert "- can_submit_analysis: false" in text
    assert "- submittable_stages: specify, tasks" in text


@pytest.mark.anyio
async def test_start_planning_refuses_a_scratch_project(app):
    async with _running(app):
        app.state.github_client = FakeGithubClient()
        _, pid = _scratch_project(TestClient(app))
        result = await _call(app, "alice", "start_planning", {"project_id": pid})
    assert _error(result).startswith("repo_not_imported: ")


@pytest.mark.anyio
async def test_start_planning_needs_a_project(app):
    async with _running(app):
        result = await _call(app, "alice", "start_planning", {})
    assert _error(result) == "project_required: pass project_id or repo_url"


@pytest.mark.anyio
async def test_submit_repo_analysis_opens_the_gate(app):
    async with _running(app) as repo:
        pid = _imported(app)
        result = await _call(
            app, "alice", "submit_repo_analysis", {"repo_url": REPO_URL, **ANALYSIS}
        )
        assert not result.is_error, _text(result)
        assert _text(result) == (
            f"Baseline accepted for Story App at {HEAD}; "
            "the plan and tasks stages are now open for drafts."
        )
        stored = repo.get_repo_analysis(pid)
        assert (stored.status, stored.source, stored.created_by) == (
            "baseline_ready", "agent", "alice"
        )  # fmt: skip
        brief = await _call(app, "alice", "start_planning", {"project_id": pid})
    assert "- analysis_status: baseline_ready" in _text(brief)
    assert "Express app." in _text(brief).split("## Baseline")[1]


@pytest.mark.anyio
async def test_submit_repo_analysis_is_admin_only(app):
    async with _running(app) as repo:
        pid = _imported(app)
        result = await _call(
            app, "bob", "submit_repo_analysis", {"project_id": pid, **ANALYSIS}
        )
        assert repo.get_repo_analysis(pid) is None
    assert _error(result) == (
        "admin_required: only a workspace admin can submit the repository analysis; "
        "ask one to run this step."
    )


@pytest.mark.anyio
async def test_submit_repo_analysis_reports_invalid_input(app):
    async with _running(app):
        pid = _imported(app)
        result = await _call(
            app, "alice", "submit_repo_analysis",
            {"project_id": pid, **ANALYSIS, "commit_sha": "abc123"},
        )  # fmt: skip
    assert _error(result).startswith("invalid_input: commit_sha: ")


@pytest.mark.anyio
async def test_submit_stage_draft_returns_warnings_as_the_stdio_tool_does(app):
    markdown = (
        "# Tasks\n\n"
        "## Phase 1: Pagination\n"
        "- [ ] T001 Change `src/server.js`\n"
        "- [ ] T003 Add pagination in `src/lib/paginate.js`\n"
    )
    async with _running(app) as repo:
        pid = _imported(app)
        await _call(app, "alice", "submit_repo_analysis", {"project_id": pid, **ANALYSIS})
        result = await _call(
            app, "bob", "submit_stage_draft",
            {"repo_url": "git@github.com:acme/storyapp.git", "stage": "tasks",
             "markdown": markdown, "model": "claude-opus-5-5"},
        )  # fmt: skip
        stored = repo.get_stage_draft(pid, "tasks")
    assert not result.is_error, _text(result)
    assert _text(result) == (
        "Draft for tasks is pending review in PromptWorkspace.\n"
        "\n"
        "Warnings to fix and resubmit:\n"
        "- Task numbers missing: T002\n"
        "- T003 names a path not in the repository: src/lib/paginate.js — "
        "mark it (new) or use an existing path"
    )
    assert stored.status == "pending" and stored.created_by == "bob"
    assert stored.markdown == markdown


@pytest.mark.anyio
async def test_submit_stage_draft_without_warnings(app):
    async with _running(app):
        pid = _imported(app)
        result = await _call(
            app, "alice", "submit_stage_draft",
            {"project_id": pid, "stage": "specify", "markdown": "# Spec\n\nPaged lists.\n"},
        )  # fmt: skip
    assert _text(result) == "Draft for specify is pending review in PromptWorkspace."


@pytest.mark.anyio
async def test_a_member_submitting_constitution_is_told_it_needs_an_admin(app):
    async with _running(app) as repo:
        pid = _imported(app)
        result = await _call(
            app, "bob", "submit_stage_draft",
            {"project_id": pid, "stage": "constitution", "markdown": "# Rules\n\nBe kind.\n"},
        )  # fmt: skip
        assert repo.get_stage_draft(pid, "constitution") is None
    assert _error(result) == (
        "admin_required: only a workspace admin can author constitution in this project; ask one."
    )


@pytest.mark.anyio
async def test_submit_stage_draft_reports_an_invalid_stage(app):
    async with _running(app):
        pid = _imported(app)
        result = await _call(
            app, "alice", "submit_stage_draft",
            {"project_id": pid, "stage": "implement", "markdown": "x"},
        )  # fmt: skip
    assert _error(result).startswith("invalid_input: stage: ")


@pytest.mark.anyio
async def test_a_non_member_cannot_reach_the_project_by_id(app):
    async with _running(app):
        pid = _imported(app)
        result = await _call(app, "mallory", "start_planning", {"project_id": pid})
        by_url = await _call(app, "mallory", "start_planning", {"repo_url": REPO_URL})
    assert _error(result).startswith("not_a_member: ")
    assert _error(by_url) == (
        f"no_project_for_repo: no project in your workspaces uses {REPO_URL}; pass project_id"
    )


def test_warning_lines_match_the_stdio_tool():
    """apps/mcp/src/planning.ts::warningLines, bullet for bullet."""
    lines = [
        line
        for w in (
            StageDraftWarning(code="empty_document", items=[]),
            StageDraftWarning(code="no_task_lines", items=[]),
            StageDraftWarning(code="missing_task_numbers", items=["T002", "T004"]),
            StageDraftWarning(
                code="unmarked_new_paths",
                items=[{"ref": "T003", "path": "src/a.js"}, {"path": "b.js"}],
            ),
        )
        for line in warning_lines(w)
    ]
    assert lines == [
        "- The document is empty after parsing",
        '- No task lines found: use "- [ ] T001 title" lines under "## Phase N:" headings',
        "- Task numbers missing: T002, T004",
        "- T003 names a path not in the repository: src/a.js — "
        "mark it (new) or use an existing path",
        "- undefined names a path not in the repository: b.js — "
        "mark it (new) or use an existing path",
    ]


def test_template_fences_outrun_any_backtick_run():
    brief = PlanningBriefOut(
        project_id="p", project_name="P", project_description="", repo_url=None,
        default_branch="main", can_submit_analysis=False, policy_context="",
        templates={"constitution": "shows ````md\nx\n```` inside", "specify": "s",
                   "plan": "p", "tasks": "t"},
        prd_texts=[], analysis_status="none", baseline="", drafts=[],
        submittable_stages=[], instructions="Go.",
    )  # fmt: skip
    text = render_brief(brief)
    assert "`````markdown\nshows ````md\nx\n```` inside\n`````" in text
    assert "### specify\n\n```markdown\ns\n```" in text
    assert "- repo_url: none" in text and "- submittable_stages: none" in text
