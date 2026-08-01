"""Git-host integration API (M11): connection management + inbound webhooks.

  GET    /workspaces/{id}/integrations/github   admin — non-secret status
  PUT    /workspaces/{id}/integrations/github   admin — connect (verify + store PAT)
  DELETE /workspaces/{id}/integrations/github   admin — disconnect
  POST   /api/webhooks/github                   public, signature-verified

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
    GithubAuthError,
    GithubWriteError,
    extract_task_refs,
    parse_pull_request_event,
    parse_push_event,
    verify_signature,
)
from app.integrations.github_auth import github_config
from app.models.schemas import (
    Artifact,
    ArtifactKind,
    GithubConnectionOut,
    GithubConnectRequest,
    GraphUpsertRequest,
    PullRequest,
    Workspace,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue

logger = logging.getLogger("promptconnext.github")
router = APIRouter(tags=["github"])


def _connection_out(workspace: Workspace | None) -> GithubConnectionOut:
    config = github_config(workspace)
    if config is None:
        return GithubConnectionOut(connected=False)
    return GithubConnectionOut(
        connected=True,
        owner=config.get("owner"),
        owner_type=config.get("owner_type"),
        account_login=config.get("account_login"),
        token_expires_at=config.get("token_expires_at"),
        connected_at=config.get("connected_at"),
    )


@router.get(
    "/workspaces/{workspace_id}/integrations/github", response_model=GithubConnectionOut
)
def get_github_connection(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GithubConnectionOut:
    require_admin(repo, workspace_id, user)
    return _connection_out(repo.get_workspace(workspace_id))


@router.put(
    "/workspaces/{workspace_id}/integrations/github", response_model=GithubConnectionOut
)
async def connect_github(
    workspace_id: str,
    body: GithubConnectRequest,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GithubConnectionOut:
    """Verify the PAT against GitHub, then store it encrypted.

    Verification is not a nicety: a token that cannot reach `owner` produces a
    workspace that looks connected in settings and fails at tech-review exit,
    hours later, in front of a Tech Lead who cannot tell why. Failing here
    costs one round-trip and reports the actual problem.
    """
    require_admin(repo, workspace_id, user)
    owner = body.owner.strip()
    token = body.token.strip()
    if not owner or not token:
        raise HTTPException(status_code=422, detail="owner_and_token_required")

    try:
        identity = await request.app.state.github_client.verify_token(token, owner)
    except GithubAuthError:
        raise HTTPException(status_code=400, detail="github_token_rejected") from None
    except GithubWriteError as exc:
        raise HTTPException(status_code=502, detail="github_unreachable") from exc

    if not identity.can_access_owner:
        raise HTTPException(status_code=400, detail="github_owner_not_accessible")

    ws = repo.get_workspace(workspace_id)
    merged = dict(ws.integration_config) if ws else {}
    merged["github"] = {
        "auth_kind": "pat",
        "owner": owner,
        "owner_type": identity.owner_type,
        "account_login": identity.login,
        "token_expires_at": identity.expires_at,
        "secret_ref": request.app.state.secret_store.encrypt(token),
        "connected_at": utcnow().isoformat(),
        "connected_by": user.id,
    }
    return _connection_out(repo.update_workspace(workspace_id, integration_config=merged))


@router.delete(
    "/workspaces/{workspace_id}/integrations/github", response_model=GithubConnectionOut
)
def disconnect_github(
    workspace_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> GithubConnectionOut:
    """Drop the stored credential. Existing repos and their webhooks are left
    alone — they belong to the customer's GitHub account, not to us; only our
    ability to call on their behalf goes away."""
    require_admin(repo, workspace_id, user)
    ws = repo.get_workspace(workspace_id)
    merged = dict(ws.integration_config) if ws else {}
    merged.pop("github", None)
    return _connection_out(repo.update_workspace(workspace_id, integration_config=merged))


@router.post("/api/webhooks/github")
async def github_webhook(request: Request, repo: Repository = Depends(get_repository)) -> dict:
    raw = await request.body()

    event_type = request.headers.get("x-github-event", "")
    payload = await request.json()
    repo_full_name = (payload.get("repository") or {}).get("full_name")
    if not repo_full_name:
        # A ping with no repository (org-level hook) or a malformed body.
        # Nothing to route and nothing to verify against; ack and move on.
        return {"received": True, "matched": False}

    # Routing comes BEFORE signature verification, because under per-repo
    # secrets the repository *is* what selects the key. That inverts the old
    # order but weakens nothing: an unknown repo is rejected without ever
    # touching the payload, and a known one is still verified below.
    binding = repo.get_repo_webhook(repo_full_name)
    if binding is None:
        # A repo we hold no secret for — not necessarily hostile (a hook left
        # over from a disconnected workspace). Ack so GitHub stops retrying.
        return {"received": True, "matched": False}

    try:
        secret = request.app.state.secret_store.decrypt(binding.secret_ref)
    except Exception:  # noqa: BLE001 - unusable secret must not 500 a public route
        logger.warning("webhook secret for %s could not be decrypted", repo_full_name)
        raise HTTPException(status_code=401, detail="invalid_signature") from None

    signature = request.headers.get("x-hub-signature-256")
    if not verify_signature(raw, signature, secret):
        raise HTTPException(status_code=401, detail="invalid_signature")

    if event_type == "ping":
        return {"received": True}

    project = repo.get_project(binding.project_id)
    if project is None:
        return {"received": True, "matched": False}

    if event_type == "pull_request":
        _handle_pull_request(request.app, repo, binding.workspace_id, binding.project_id, payload)
    elif event_type == "push":
        _handle_push(
            request.app,
            repo,
            binding.workspace_id,
            binding.project_id,
            {"repo": repo_full_name, "default_branch": project.repo_default_branch or "main"},
            payload,
        )

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
