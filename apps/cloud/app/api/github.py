"""Git-host integration API (M11): install + inbound webhooks.

  POST /workspaces/{id}/integrations/github/install   admin — non-secret config
  POST /api/webhooks/github                           public, signature-verified

Doesn't reuse app/api/integrations.py's tracker_webhook — that endpoint's
contract (adapter.handle_webhook -> pmo-only InboundUpdate) is shaped around
Jira/ClickUp field mirroring; GitHub's events drive indexing, not task field
updates. See app/integrations/github.py's module docstring.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_admin
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.integrations.github import (
    extract_task_refs,
    parse_pull_request_event,
    parse_push_event,
    verify_signature,
)
from app.models.schemas import (
    Artifact,
    ArtifactKind,
    GithubInstallRequest,
    GraphUpsertRequest,
    PullRequest,
    Workspace,
)
from app.rag.queue import EmbedJob, enqueue

logger = logging.getLogger("promptzone.github")
router = APIRouter(tags=["github"])


@router.post("/workspaces/{workspace_id}/integrations/github/install", response_model=Workspace)
def install_github(
    workspace_id: str,
    body: GithubInstallRequest,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    require_admin(repo, workspace_id, user)
    project = repo.get_project(body.project_id)
    if project is None or project.workspace_id != workspace_id:
        raise HTTPException(status_code=422, detail="project_not_in_workspace")

    ws = repo.get_workspace(workspace_id)
    merged = dict(ws.integration_config) if ws else {}
    merged["github"] = {
        "installation_id": body.installation_id,
        "repo": body.repo,
        "default_branch": body.default_branch,
        "project_id": body.project_id,
    }
    return repo.update_workspace(workspace_id, integration_config=merged)


@router.post("/api/webhooks/github")
async def github_webhook(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    raw = await request.body()
    settings = request.app.state.settings
    signature = request.headers.get("x-hub-signature-256")
    if not verify_signature(raw, signature, settings.github_webhook_secret):
        raise HTTPException(status_code=401, detail="invalid_signature")

    event_type = request.headers.get("x-github-event", "")
    if event_type == "ping":
        return {"received": True}

    payload = await request.json()
    repo_full_name = (payload.get("repository") or {}).get("full_name")
    if not repo_full_name:
        return {"received": True, "matched": False}

    workspace = repo.find_workspace_by_github_repo(repo_full_name)
    if workspace is None:
        # Not an error — a repo the App can see but no workspace has
        # installed/configured yet. Ack so GitHub doesn't retry forever.
        return {"received": True, "matched": False}

    github_config = workspace.integration_config["github"]
    project_id = github_config["project_id"]

    if event_type == "pull_request":
        _handle_pull_request(request.app, repo, workspace.id, project_id, payload)
    elif event_type == "push":
        _handle_push(request.app, repo, workspace.id, project_id, github_config, payload)

    return {"received": True, "matched": True}


def _handle_pull_request(
    app, repo: Repository, workspace_id: str, project_id: str, payload: dict
) -> None:
    event = parse_pull_request_event(payload)
    if event is None:
        return

    # Task linkage via the same T-ref commit convention syncTasksFromGit uses
    # (apps/engine/src/routes/projects.ts) — a PR with no matching task is
    # skipped entirely, same as that function's `if (!task) continue`.
    refs = extract_task_refs(f"{event.title}\n{event.body}")
    graph = repo.get_graph(project_id)
    task_id = next(
        (t.id for t in graph.tasks if t.feature_tag and t.feature_tag.split(" ")[0] in refs),
        None,
    )
    if task_id is None:
        return

    pr_id = f"pr-{project_id}-{event.number}"
    pr = PullRequest(
        id=pr_id,
        project_id=project_id,
        number=event.number,
        title=event.title,
        body=event.body,
        html_url=event.html_url,
        head_sha=event.head_sha,
        task_id=task_id,
        merged=event.merged,
    )
    repo.upsert_pull_request(pr)

    artifact = Artifact(
        id=pr_id,
        project_id=project_id,
        task_id=task_id,
        kind=ArtifactKind.pr,
        uri=event.html_url,
        commit_sha=event.head_sha,
    )
    repo.upsert_graph(project_id, GraphUpsertRequest(artifacts=[artifact]), source="pz")

    enqueue(app, EmbedJob(workspace_id, project_id, "pull_requests", pr_id))


def _handle_push(
    app, repo: Repository, workspace_id: str, project_id: str, github_config: dict, payload: dict
) -> None:
    event = parse_push_event(payload, github_config["default_branch"])
    if event is None:
        return
    repo_name = github_config["repo"]

    for path in event.removed_paths:
        repo.delete_code_chunks_for_path(project_id, repo_name, path)

    for path in event.changed_paths:
        # Fetch + chunk + embed happens off the request path (app/rag/queue.py)
        # — never block a webhook response on a Git-host round trip.
        enqueue(
            app,
            EmbedJob(
                workspace_id,
                project_id,
                "code_file",
                node_id=f"{repo_name}:{path}",
                repo=repo_name,
                path=path,
                sha=event.after_sha,
            ),
        )
