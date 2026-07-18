"""External-tracker integration API (M5).

Three surfaces:
  * configure (admin) — store non-secret provider settings on the workspace;
  * mirror out (member) — push one task to the tracker, recording the link;
  * webhook in (public, signature-verified) — apply pmo-only updates.

Secrets (API token, webhook secret) come from the server env, never the DB.
"""

from __future__ import annotations

import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_admin, require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.integrations import get_adapter, list_providers
from app.models.schemas import (
    Discussion,
    GraphUpsertRequest,
    TaskLink,
    Workspace,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

logger = logging.getLogger("promptconnext.integrations")
router = APIRouter(tags=["integrations"])

# Provider-specific webhook signature headers.
_SIGNATURE_HEADER = {"jira": "x-hub-signature-256", "clickup": "x-signature"}


def _webhook_secret(settings, provider: str) -> str:
    return {"jira": settings.jira_webhook_secret}.get(provider, "")


def _validate_base_url(adapter, base_url: str) -> None:
    """Reject a base_url whose host is not on the adapter's allowlist. The
    outbound API token is Basic-auth'd to this host, so an arbitrary host is a
    credential-exfiltration (SSRF) vector — bound it to the provider's domain."""
    suffixes = getattr(adapter, "allowed_host_suffixes", ())
    parsed = urlparse(base_url)
    if parsed.scheme != "https":
        raise HTTPException(status_code=422, detail="base_url_must_be_https")
    host = (parsed.hostname or "").lower()
    if not host or not any(
        host == s.lstrip(".") or host.endswith(s) for s in suffixes
    ):
        raise HTTPException(
            status_code=422,
            detail=f"base_url_host_not_allowed:{host or 'none'}",
        )


def _outbound_auth(settings, provider: str) -> tuple | dict | None:
    """Return httpx auth (tuple) or headers (dict) for an outbound call, or None
    when credentials are unconfigured."""
    if provider == "jira":
        if settings.jira_email and settings.jira_api_token:
            return ("basic", settings.jira_email, settings.jira_api_token)
    return None


# --------------------------------------------------------------------------- #
# Configure
# --------------------------------------------------------------------------- #
@router.post("/workspaces/{workspace_id}/integrations/{provider}", response_model=Workspace)
def configure_integration(
    workspace_id: str,
    provider: str,
    config: dict,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Workspace:
    adapter = get_adapter(provider)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")
    if "base_url" not in config or "project_key" not in config:
        raise HTTPException(status_code=422, detail="base_url_and_project_key_required")
    _validate_base_url(adapter, config["base_url"])
    ws = require_admin(repo, workspace_id, user)
    merged = dict(ws.integration_config)
    merged[provider] = config
    return repo.update_workspace(workspace_id, integration_config=merged)


# --------------------------------------------------------------------------- #
# Mirror one task outbound
# --------------------------------------------------------------------------- #
@router.post("/projects/{project_id}/tasks/{task_id}/mirror", response_model=TaskLink)
def mirror_task(
    project_id: str,
    task_id: str,
    request: Request,
    provider: str = "jira",
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> TaskLink:
    project = require_project(repo, project_id, user)
    adapter = get_adapter(provider)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")

    workspace = repo.get_workspace(project.workspace_id)
    config = (workspace.integration_config or {}).get(provider) if workspace else None
    if not config:
        raise HTTPException(status_code=400, detail="integration_not_configured")

    # Defense in depth: re-validate the stored base_url before sending the token,
    # in case the allowlist tightened after the config was saved.
    _validate_base_url(adapter, config.get("base_url", ""))

    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    settings = request.app.state.settings
    auth = _outbound_auth(settings, provider)
    if auth is None:
        raise HTTPException(status_code=400, detail="tracker_credentials_missing")

    outbound = adapter.build_push(task, config)
    try:
        body = _send(outbound, auth)
    except httpx.HTTPError as exc:  # pragma: no cover - network failure path
        logger.warning("mirror push failed: %s", exc)
        raise HTTPException(status_code=502, detail="tracker_request_failed") from exc

    external_key, external_url = adapter.parse_push_response(body, config)
    link = TaskLink(
        task_id=task_id,
        project_id=project_id,
        provider=provider,
        external_key=external_key,
        external_url=external_url,
        updated_at=utcnow(),
    )
    return repo.upsert_task_link(link)


def _send(outbound, auth) -> dict:
    headers = {"Accept": "application/json"}
    kwargs: dict = {}
    if isinstance(auth, tuple) and auth and auth[0] == "basic":
        kwargs["auth"] = (auth[1], auth[2])
    elif isinstance(auth, dict):
        headers.update(auth)
    with httpx.Client(timeout=15) as client:
        resp = client.request(
            outbound.method, outbound.url, json=outbound.json, headers=headers, **kwargs
        )
        resp.raise_for_status()
        return resp.json()


# --------------------------------------------------------------------------- #
# Inbound webhook (public, signature-verified)
# --------------------------------------------------------------------------- #
@router.post("/api/webhooks/{provider}")
async def tracker_webhook(
    provider: str,
    request: Request,
    repo: Repository = Depends(get_repository),
) -> dict:
    adapter = get_adapter(provider)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")

    raw = await request.body()
    settings = request.app.state.settings
    secret = _webhook_secret(settings, provider)
    signature = request.headers.get(_SIGNATURE_HEADER.get(provider, ""))
    if not adapter.verify_signature(raw, signature, secret):
        raise HTTPException(status_code=401, detail="invalid_signature")

    payload = await request.json()

    # Comments (M12) are a different shape from field updates — routed
    # separately, not through handle_webhook()/InboundUpdate. Optional: only
    # Jira implements this today (see TrackerAdapter's docstring note).
    parse_comment = getattr(adapter, "parse_comment_webhook", None)
    comment = parse_comment(payload, {}) if parse_comment else None
    if comment is not None:
        applied = _apply_inbound_comment(request.app, repo, provider, comment)
        return {"received": 1, "applied": applied}

    updates = adapter.handle_webhook(payload, {})  # config not needed for parse
    applied = 0
    for update in updates:
        link = repo.find_task_link_by_key(provider, update.external_key)
        if link is None:
            continue
        task = repo.get_task(link.project_id, link.task_id)
        if task is None:
            continue
        # Overlay pmo fields onto the stored task and push with source="pmo".
        # M3's merge writes only pmo fields; pz fields (e.g. status) are dropped.
        if update.assignee is not None:
            task.assignee = update.assignee
        if update.sprint is not None:
            task.sprint = update.sprint
        if update.status is not None:
            task.status = update.status  # dropped by merge (status is pz) — by design
        repo.upsert_graph(
            link.project_id, GraphUpsertRequest(tasks=[task], source="pmo"), source="pmo"
        )
        applied += 1
    return {"received": len(updates), "applied": applied}


def _apply_inbound_comment(app, repo: Repository, provider: str, comment) -> int:
    link = repo.find_task_link_by_key(provider, comment.external_key)
    if link is None:
        return 0
    task = repo.get_task(link.project_id, link.task_id)
    project = repo.get_project(link.project_id)
    if task is None or project is None:
        return 0

    # Deterministic id: re-delivery of the same webhook (Jira retries on a
    # non-2xx, or a "created" followed by an "updated") upserts the same row
    # rather than creating duplicates.
    discussion = Discussion(
        id=f"{provider}-comment-{comment.comment_id}",
        project_id=link.project_id,
        parent_node_type="tasks",
        parent_node_id=link.task_id,
        author=comment.author,
        body=comment.body,
        source="pmo",
    )
    repo.upsert_graph(
        link.project_id, GraphUpsertRequest(discussions=[discussion]), source="pmo"
    )
    if "discussions" in RAG_NODE_TYPES:
        enqueue(app, EmbedJob(project.workspace_id, link.project_id, "discussions", discussion.id))
    return 1


@router.get("/integrations/providers")
def providers() -> dict:
    return {"providers": list_providers()}
