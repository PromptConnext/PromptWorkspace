"""External-tracker integration API (M5).

Three surfaces:
  * configure (admin) — store non-secret provider settings on the workspace;
  * mirror out (member) — push one task to the tracker, recording the link;
  * webhook in (public, signature-verified) — apply pmo-only updates.

Secrets (API token, webhook secret) come from the server env, never the DB.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_admin, require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.integrations import get_adapter, list_providers
from app.models.schemas import (
    GraphUpsertRequest,
    TaskLink,
    Workspace,
    utcnow,
)

logger = logging.getLogger("promptzone.integrations")
router = APIRouter(tags=["integrations"])

# Provider-specific webhook signature headers.
_SIGNATURE_HEADER = {"jira": "x-hub-signature-256", "clickup": "x-signature"}


def _webhook_secret(settings, provider: str) -> str:
    return {"jira": settings.jira_webhook_secret}.get(provider, "")


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
    if get_adapter(provider) is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")
    if "base_url" not in config or "project_key" not in config:
        raise HTTPException(status_code=422, detail="base_url_and_project_key_required")
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
        raise HTTPException(status_code=502, detail="tracker_request_failed")

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


@router.get("/integrations/providers")
def providers() -> dict:
    return {"providers": list_providers()}
