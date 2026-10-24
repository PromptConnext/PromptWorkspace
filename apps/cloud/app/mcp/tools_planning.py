"""The three planning tools of the hosted MCP server: start_planning,
submit_repo_analysis, submit_stage_draft. Same names, output and meaning as
the stdio server's (apps/mcp/src/planning.ts), minus `workspace_root`: a
hosted server has no clone to read, so the project comes from `project_id`
or `repo_url` (app/mcp/repo_url.py::resolve_project).

Every tool takes its user from the verified bearer (`current_user()`), never
from an argument, reaches its project only through `resolve_project` (which
runs `require_project`), and then calls the very helper the HTTP route calls
— `planning_brief_for`, `submit_agent_analysis_for`, `submit_stage_draft_for`
— so the role and import checks are the routes' own."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import ValidationError

from app.api.repo_analysis import submit_agent_analysis_for
from app.api.stage_drafts import (
    STAGES,
    PlanningBriefOut,
    planning_brief_for,
    submit_stage_draft_for,
)
from app.db.repository import Repository
from app.mcp.auth import current_user
from app.mcp.repo_url import resolve_project
from app.models.schemas import AgentRepoAnalysisIn, StageDraftIn, StageDraftWarning

HOSTED_READ_LINE = (
    "Read AGENTS.md, docs/conventions.md and .specify/memory/constitution.md from your "
    "clone before drafting; this server cannot see your files."
)

# HTTPException detail -> the sentence an agent reads after it. The 409s are
# planning.ts's CONFLICT_SENTENCES.
_SENTENCES = {
    "repo_not_imported": "this project was started from scratch, so there is nothing to analyze",
    "repo_already_created": (
        "the repository is already created, so planning drafts are no longer accepted"
    ),
    "not_a_member": "you are not a member of this project's workspace.",
    "project_not_found": "no project has that id; pass a project_id from your workspaces.",
    "workspace_not_found": "the project's workspace no longer exists.",
}


def _refusal(err: HTTPException, admin_sentence: str) -> ToolError:
    detail = str(err.detail)
    if detail == "admin_required":
        return ToolError(f"admin_required: {admin_sentence}")
    return ToolError(f"{detail}: {_SENTENCES.get(detail, 'the request was refused.')}")


def _invalid_input(err: ValidationError) -> ToolError:
    first = err.errors()[0]
    field = ".".join(str(part) for part in first.get("loc", ()))
    message = first.get("msg", "invalid value")
    return ToolError(f"invalid_input: {field}: {message}" if field else f"invalid_input: {message}")


# ------------------------------------------------------------ start_planning


def _fence(body: str) -> str:
    """Longer than any backtick run in the template, so a template that itself
    shows a fenced example cannot close this one early."""
    longest = max((len(run) for run in re.findall(r"`+", body)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}markdown\n{body.strip()}\n{ticks}"


def _or_none(value: str | None) -> str:
    return value.strip() if value and value.strip() else "none"


def _bool(value: bool) -> str:
    return "true" if value else "false"


def render_brief(brief: PlanningBriefOut) -> str:
    """planning.ts::renderBrief, plus HOSTED_READ_LINE under Instructions."""
    lines: list[str] = [
        "## Instructions", "", brief.instructions.strip(), "", HOSTED_READ_LINE, "",
    ]  # fmt: skip

    lines += [
        "## Project",
        "",
        f"- name: {brief.project_name}",
        f"- repo_url: {_or_none(brief.repo_url)}",
        f"- default_branch: {brief.default_branch}",
        f"- can_submit_analysis: {_bool(brief.can_submit_analysis)}",
        f"- analysis_status: {brief.analysis_status}",
        f"- submittable_stages: {', '.join(brief.submittable_stages) or 'none'}",
        "",
    ]

    lines += ["## Drafts", ""]
    if not brief.drafts:
        lines.append("none")
    for d in brief.drafts:
        lines.append(
            f"- {d.stage}: {d.status}, stale: {_bool(d.stale)}, "
            f"rejection_note: {_or_none(d.rejection_note)}, last_error: {_or_none(d.last_error)}"
        )
    lines.append("")

    lines += ["## Baseline", "", _or_none(brief.baseline), ""]
    lines += ["## Policy context", "", _or_none(brief.policy_context), ""]

    lines += ["## PRDs", ""]
    if not brief.prd_texts:
        lines += ["none", ""]
    for prd in brief.prd_texts:
        lines += [f"### {prd['title']}", "", prd["text"].strip(), ""]

    lines += ["## Templates", ""]
    for stage in STAGES:
        lines += [f"### {stage}", "", _fence(brief.templates.get(stage, "")), ""]

    return "\n".join(lines).rstrip() + "\n"


# -------------------------------------------------------- submit_stage_draft


_UNDEFINED = object()


def warning_lines(warning: StageDraftWarning) -> list[str]:
    """planning.ts::warningLines, line for line."""
    if warning.code == "missing_task_numbers":
        return [f"- Task numbers missing: {', '.join(_js_string(i) for i in warning.items)}"]
    if warning.code == "no_task_lines":
        return ['- No task lines found: use "- [ ] T001 title" lines under "## Phase N:" headings']
    if warning.code == "empty_document":
        return ["- The document is empty after parsing"]
    lines = []
    for item in warning.items:
        item = item if isinstance(item, dict) else {}
        lines.append(
            f"- {_js_string(item.get('ref', _UNDEFINED))} names a path not in the repository: "
            f"{_js_string(item.get('path', _UNDEFINED))} — mark it (new) or use an existing path"
        )
    return lines


def _js_string(value: Any) -> str:
    """`String(value)` as planning.ts renders an item."""
    if value is _UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return _bool(value)
    return str(value)


# ------------------------------------------------------------- registration


def register_planning_tools(
    server: MCPServer,
    repo_provider: Callable[[], Repository],
    app_provider: Callable[[], Any] | None = None,
) -> None:
    del app_provider  # none of the planning writes reaches app state

    @server.tool()
    def start_planning(project_id: str | None = None, repo_url: str | None = None) -> str:
        """Start planning an imported project from your clone: the instructions,
        the project's state, the drafts already submitted, the codebase
        baseline, the policy context, the PRDs and the four stage templates.
        Pass `project_id`, or `repo_url` (your clone's remote) to find it."""
        user = current_user()
        repo = repo_provider()
        project = resolve_project(repo, user, project_id=project_id, repo_url=repo_url)
        try:
            brief = planning_brief_for(repo, project, user)
        except HTTPException as err:
            raise _refusal(err, "only a workspace admin can do this.") from err
        return render_brief(brief)

    @server.tool()
    def submit_repo_analysis(
        project_id: str | None = None,
        repo_url: str | None = None,
        *,
        default_branch: str,
        commit_sha: str,
        paths: list[str],
        file_count: int,
        tree_truncated: bool = False,
        stack: dict[str, Any] | None = None,
        tree_summary: str = "",
        baseline: str,
        model: str | None = None,
    ) -> str:
        """Store the repository snapshot and codebase baseline you wrote from
        your clone (workspace admins only). `commit_sha` is the full hash of
        `origin/<default_branch>`; `paths` lists the tracked files (at most
        50,000; set `tree_truncated` when you cut it). Opens the plan and tasks
        stages for drafts."""
        user = current_user()
        try:
            fields: dict[str, Any] = {
                "default_branch": default_branch,
                "commit_sha": commit_sha,
                "paths": paths,
                "file_count": file_count,
                "tree_truncated": tree_truncated,
                "tree_summary": tree_summary,
                "baseline": baseline,
                "model": model,
            }
            if stack is not None:
                fields["stack"] = stack
            body = AgentRepoAnalysisIn(**fields)
        except ValidationError as err:
            raise _invalid_input(err) from err
        repo = repo_provider()
        project = resolve_project(repo, user, project_id=project_id, repo_url=repo_url)
        try:
            out = submit_agent_analysis_for(repo, project, user, body)
        except HTTPException as err:
            raise _refusal(
                err,
                "only a workspace admin can submit the repository analysis; "
                "ask one to run this step.",
            ) from err
        return (
            f"Baseline accepted for {project.name} at {out.commit_sha or body.commit_sha}; "
            "the plan and tasks stages are now open for drafts."
        )

    @server.tool()
    def submit_stage_draft(
        project_id: str | None = None,
        repo_url: str | None = None,
        *,
        stage: str,
        markdown: str,
        model: str | None = None,
    ) -> str:
        """Submit one stage's Markdown (constitution, specify, plan or tasks)
        as a pending draft a human accepts or rejects in PromptWorkspace.
        Returns the parse warnings to fix and resubmit, if any."""
        user = current_user()
        try:
            body = StageDraftIn(stage=stage, markdown=markdown, model=model)
        except ValidationError as err:
            raise _invalid_input(err) from err
        repo = repo_provider()
        project = resolve_project(repo, user, project_id=project_id, repo_url=repo_url)
        try:
            out = submit_stage_draft_for(repo, project, user, body)
        except HTTPException as err:
            raise _refusal(
                err,
                f"only a workspace admin can author {body.stage} in this project; ask one.",
            ) from err
        lines = [f"Draft for {body.stage} is pending review in PromptWorkspace."]
        warnings = [line for w in out.warnings for line in warning_lines(w)]
        if warnings:
            lines += ["", "Warnings to fix and resubmit:", *warnings]
        return "\n".join(lines)
