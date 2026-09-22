"""External-tracker integration API (M5).

Three surfaces:
  * configure (admin) — bind the workspace to one tracker *account*, storing
    that account's non-secret settings plus its own webhook signing secret;
  * mirror out (member) — push one task to the tracker, recording the link;
  * webhook in (public, signature-verified) — apply pmo-only updates.

The outbound API token still comes from the server env. The inbound webhook
secret does not, any more: it is minted per tracker account at configuration
time and stored as ciphertext in `pz_workspace_integrations` (plan 0019, and
`app/integrations/github.py`'s `pz_repo_webhooks` before it). A single
process-wide `JIRA_WEBHOOK_SECRET` could only prove that *some* configured Jira
sent a delivery, never which one — and since a Jira issue key is unique per
site rather than per provider, "which one" is exactly what routing needs.
"""

from __future__ import annotations

import json
import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_admin, require_project
from app.db.repository import Repository, TrackerAccountConflict
from app.dependencies import User, get_current_user, get_repository
from app.integrations import get_adapter, is_available, list_providers
from app.integrations.account import new_webhook_secret, normalize_account_key
from app.models.schemas import (
    Discussion,
    GraphUpsertRequest,
    TaskLink,
    TrackerIntegrationOut,
    WorkspaceIntegration,
    utcnow,
)
from app.rag.queue import EmbedJob, enqueue
from app.rag.source import RAG_NODE_TYPES

logger = logging.getLogger("promptconnext.integrations")
router = APIRouter(tags=["integrations"])

# Provider-specific webhook signature headers, most-canonical first.
#
# Jira Cloud sends `X-Hub-Signature`, not GitHub's `X-Hub-Signature-256`: the
# header is WebSub's, and the algorithm travels in the *value* as
# `sha256=<hex>` rather than in the header name (Atlassian, "Webhooks — Jira
# Cloud platform": the signature is "formatted as `method=signature`, as
# defined by WebSub"). This code read the GitHub name, which meant
# `request.headers.get(...)` was None for every real Jira delivery and
# `verify_signature` refused it — the inbound path could never have worked
# against a real site, under the old shared secret or the new per-account one.
# The `-256` spelling is still accepted because it costs nothing and some
# senders (and this repo's own older tests) use it.
_SIGNATURE_HEADERS = {
    "jira": ("x-hub-signature", "x-hub-signature-256"),
    "clickup": ("x-signature",),
}


def _signature_of(request: Request, provider: str) -> str | None:
    for header in _SIGNATURE_HEADERS.get(provider, ()):
        value = request.headers.get(header)
        if value:
            return value
    return None


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
def _integration_out(
    integration: WorkspaceIntegration, *, webhook_secret: str | None = None
) -> TrackerIntegrationOut:
    """Project a binding for the admin. `webhook_secret` is passed only by the
    two call sites that just minted one; everything else leaves it None."""
    return TrackerIntegrationOut(
        workspace_id=integration.workspace_id,
        provider=integration.provider,
        account_key=integration.account_key,
        webhook_secret=webhook_secret,
        signature_header=_SIGNATURE_HEADERS.get(integration.provider, ("",))[0],
    )


def _mint_secret(request: Request, integration_fields: dict) -> tuple[WorkspaceIntegration, str]:
    """A fresh secret, encrypted for storage and returned once in plaintext.

    `require_rag()` guards the encryption itself, not the feature: with
    DATA_BACKEND=supabase and no RAG_KEY_ENCRYPTION_KEY, `build_secret_store`
    falls back to `MemorySecretStore`, which is base64 — reversible by anyone
    who can read the row, and not encryption in any sense. A webhook signing
    secret stored that way is a secret in name only, so this refuses rather
    than storing one. Same guard, same reason, as the model-connection route
    (app/api/assistant.py).
    """
    request.app.state.settings.require_rag()
    plaintext = new_webhook_secret()
    integration = WorkspaceIntegration(
        **integration_fields,
        webhook_secret_ref=request.app.state.secret_store.encrypt(plaintext),
    )
    return integration, plaintext


@router.post(
    "/workspaces/{workspace_id}/integrations/{provider}",
    response_model=TrackerIntegrationOut,
)
def configure_integration(
    workspace_id: str,
    provider: str,
    config: dict,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> TrackerIntegrationOut:
    adapter = get_adapter(provider)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")
    if not is_available(provider):
        # Registered but not usable end to end — see app/integrations/registry.py.
        # Accepting settings nothing can act on is the defect plan 0019 M4 names.
        raise HTTPException(status_code=400, detail=f"provider_unavailable:{provider}")
    if "base_url" not in config or "project_key" not in config:
        raise HTTPException(status_code=422, detail="base_url_and_project_key_required")
    _validate_base_url(adapter, config["base_url"])
    account_key = normalize_account_key(config["base_url"])
    if not account_key:
        # _validate_base_url already required https + an allowlisted host, so
        # this is unreachable in practice; it is here because an empty
        # account_key must never reach the table (it is the pre-0032 backfill
        # value on pz_task_links.account_key).
        raise HTTPException(status_code=422, detail="base_url_invalid")
    ws = require_admin(repo, workspace_id, user)

    existing = repo.get_workspace_integration(workspace_id, provider)
    if existing is not None and existing.account_key == account_key:
        # Re-saving settings for the same site keeps its secret, so the webhook
        # already registered on the Jira side goes on validating — and, because
        # nothing was minted, this response reveals nothing. Only a change of
        # account mints, and only a mint reveals.
        integration = existing.model_copy(update={"updated_at": utcnow()})
        revealed: str | None = None
    else:
        integration, revealed = _mint_secret(
            request,
            {"workspace_id": workspace_id, "provider": provider, "account_key": account_key},
        )
    try:
        repo.upsert_workspace_integration(integration)
    except TrackerAccountConflict as exc:
        # Another workspace owns this site. Refusing is the point: two
        # workspaces sharing one account_key would restore the ambiguity that
        # let one tenant's PZ-1 update another's.
        raise HTTPException(
            status_code=409, detail=f"tracker_account_already_bound:{account_key}"
        ) from exc

    # The blob keeps the non-secret settings it always held (base_url,
    # project_key, status_map). Only the account identity and the secret moved.
    merged = dict(ws.integration_config)
    merged[provider] = config
    repo.update_workspace(workspace_id, integration_config=merged)
    return _integration_out(integration, webhook_secret=revealed)


@router.post(
    "/workspaces/{workspace_id}/integrations/{provider}/webhook-secret/rotate",
    response_model=TrackerIntegrationOut,
)
def rotate_webhook_secret(
    workspace_id: str,
    provider: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> TrackerIntegrationOut:
    """Mint a replacement secret for an existing binding and reveal it once.

    Needed because the reveal at configure time happens exactly once and there
    is deliberately no route that answers with a stored secret. Without this,
    an admin who lost the secret could only recover by unbinding and
    rebinding — and `unique (provider, account_key)` makes that worse than it
    sounds: the row would have to be deleted before the same site could be
    claimed again, and there is no delete route either. Rotation is the
    supported recovery path, and it is also how you respond to a suspected
    leak. The previous secret stops verifying the moment this returns, so the
    Jira-side webhook must be updated with the new one.
    """
    if get_adapter(provider) is None:
        raise HTTPException(status_code=404, detail=f"unknown_provider:{provider}")
    require_admin(repo, workspace_id, user)
    existing = repo.get_workspace_integration(workspace_id, provider)
    if existing is None:
        raise HTTPException(status_code=404, detail="integration_not_configured")

    integration, revealed = _mint_secret(
        request,
        {
            "workspace_id": workspace_id,
            "provider": provider,
            "account_key": existing.account_key,
            "created_at": existing.created_at,
        },
    )
    repo.upsert_workspace_integration(integration)
    logger.info(
        "rotated %s webhook secret for workspace %s account %s",
        provider,
        workspace_id,
        existing.account_key,
    )
    return _integration_out(integration, webhook_secret=revealed)


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

    # Which account this workspace is bound to. Read from the workspace's own
    # row, never from anything the caller sends: a member mirroring a task can
    # only ever stamp the identity their workspace is actually configured
    # against, so no authenticated request can plant a link under another
    # tenant's account_key and start intercepting that tenant's deliveries.
    integration = repo.get_workspace_integration(project.workspace_id, provider)
    if integration is None:
        raise HTTPException(status_code=400, detail="integration_not_configured")

    task = repo.get_task(project_id, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task_not_found")

    # Idempotency (plan 0019 M3, finding 15). This route used to build and send
    # the create request unconditionally, then overwrite whatever link the task
    # already had — so a retried click, a client double-submit, or a timeout
    # retry whose first attempt actually succeeded left a second external issue
    # behind and lost the link to the first. Returning the existing link is the
    # whole fix; keeping the two *in sync* is deliberately not (it needs a
    # per-adapter update builder that does not exist yet).
    existing_link = repo.get_task_link(task_id, provider)
    if existing_link is not None:
        return existing_link

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
        account_key=integration.account_key,
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
    try:
        payload = json.loads(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid_payload") from None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_payload")

    # ROUTING COMES BEFORE SIGNATURE VERIFICATION, the same inversion
    # app/api/github.py::github_webhook made and for the same reason: under
    # per-account secrets, the account *is* what selects the key, so there is no
    # single secret to verify against until the account is known. This weakens
    # nothing. The account identity is read from an unverified payload, but all
    # it can do is choose which secret the signature is then checked against —
    # a caller who names an account whose secret they do not hold fails that
    # check, and a caller who names no configured account at all is refused
    # here, before a single field of their payload is trusted or a single link
    # looked up.
    account_key = _payload_account_key(adapter, payload)
    integration = (
        repo.find_workspace_integration_by_account(provider, account_key)
        if account_key
        else None
    )
    if integration is None:
        # Acked, not refused — `github_webhook`'s shape for an unrecognized
        # `repo_full_name`, and for its reason: a delivery from a site nobody
        # has configured is usually a hook left behind by a disconnected
        # workspace, not an attack, and answering 401 makes Jira retry it on a
        # backoff forever. Nothing is trusted and nothing is looked up.
        #
        # This narrows, but does not close, the fact that a caller can still
        # tell a configured site (401 on a bad signature) from an unconfigured
        # one (200). That distinction is inherent to routing before verifying —
        # the account has to be resolved before there is a key to check against
        # — and `github_webhook` has exactly the same property. What made it
        # worth acting on was the writable `account_key` on pz_task_links, which
        # migration 0032 now revokes.
        logger.warning("tracker webhook for unknown %s account %r", provider, account_key)
        return {"received": True, "matched": False}

    try:
        secret = request.app.state.secret_store.decrypt(integration.webhook_secret_ref)
    except Exception:  # noqa: BLE001 - an unusable secret must not 500 a public route
        logger.warning(
            "tracker webhook secret for %s account %s could not be decrypted",
            provider,
            integration.account_key,
        )
        raise HTTPException(status_code=401, detail="invalid_signature") from None

    signature = _signature_of(request, provider)
    if not adapter.verify_signature(raw, signature, secret):
        raise HTTPException(status_code=401, detail="invalid_signature")

    # Comments (M12) are a different shape from field updates — routed
    # separately, not through handle_webhook()/InboundUpdate. Optional: only
    # Jira implements this today (see TrackerAdapter's docstring note).
    parse_comment = getattr(adapter, "parse_comment_webhook", None)
    comment = parse_comment(payload, {}) if parse_comment else None
    if comment is not None:
        applied = _apply_inbound_comment(request.app, repo, provider, integration, comment)
        return {"received": 1, "applied": applied}

    updates = adapter.handle_webhook(payload, {})  # config not needed for parse
    applied = 0
    for update in updates:
        link = _resolve_link(repo, provider, integration, update.external_key)
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


def _payload_account_key(adapter, payload: dict) -> str:
    """The provider account a delivery claims to come from, normalized.

    Optional on the adapter, like `parse_comment_webhook`: an adapter with no
    account identity in its payloads returns nothing here, and the route then
    refuses every delivery for that provider rather than falling back to a
    provider-wide secret. That is why `app/integrations/registry.py` does not
    list such a provider as available — see plan 0019 M4."""
    extract = getattr(adapter, "account_key_from_payload", None)
    return extract(payload) if extract else ""


def _resolve_link(
    repo: Repository, provider: str, integration: WorkspaceIntegration, external_key: str
):
    """The task link this delivery may update, or None.

    Two conditions, not one. `account_key` scopes the key lookup, which is what
    stops one tenant's `PZ-1` resolving to another's. The workspace check behind
    it covers the one case the key alone does not: a link outliving the binding
    that created it. If workspace A disconnects its Jira site and workspace B
    later configures the same site, B legitimately holds that `account_key`
    while A's old rows still carry it — and without this check B's deliveries
    would start landing on A's tasks.
    """
    link = repo.find_task_link_by_key(provider, integration.account_key, external_key)
    if link is None:
        return None
    project = repo.get_project(link.project_id)
    if project is None or project.workspace_id != integration.workspace_id:
        logger.warning(
            "tracker webhook for %s account %s resolved a link outside its workspace",
            provider,
            integration.account_key,
        )
        return None
    return link


def _apply_inbound_comment(
    app, repo: Repository, provider: str, integration: WorkspaceIntegration, comment
) -> int:
    link = _resolve_link(repo, provider, integration, comment.external_key)
    if link is None:
        return 0
    task = repo.get_task(link.project_id, link.task_id)
    project = repo.get_project(link.project_id)
    if task is None or project is None:
        return 0

    # Deterministic id: re-delivery of the same webhook (Jira retries on a
    # non-2xx, or a "created" followed by an "updated") upserts the same row
    # rather than creating duplicates.
    #
    # `account_key` is in the id because a Jira comment id is internal to its
    # own site: two tenants' PZ-1 each getting comment 10001 produced the same
    # `jira-comment-10001`, so the second delivery silently overwrote the first
    # workspace's discussion row through the upsert below.
    discussion = Discussion(
        id=f"{provider}-{integration.account_key}-comment-{comment.comment_id}",
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
