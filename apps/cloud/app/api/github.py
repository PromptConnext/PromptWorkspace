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

import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from app.api._guards import require_admin
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.deployments.registry import PREVIEW_ENVIRONMENT, WORKFLOW_PATH
from app.deployments.registry import get_template as get_deployment_template
from app.deployments.state import DEPLOY_STATE_BY_GITHUB as _DEPLOY_STATE_BY_GITHUB
from app.deployments.state import refresh_deployment_state as _refresh_deployment_state
from app.integrations.deploy_providers import platform_r2_preview_url
from app.integrations.github import (
    GithubAuthError,
    GithubWriteError,
    extract_task_refs,
    parse_deployment_status_event,
    parse_pull_request_event,
    parse_push_event,
    parse_workflow_run_event,
    verify_signature,
)
from app.integrations.github_auth import github_config
from app.models.schemas import (
    Artifact,
    ArtifactKind,
    Deployment,
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
    # ADR 0021. `repo` here is already the *unscoped* service repository —
    # app/dependencies.py::get_repository returns it when a request carries no
    # Authorization header, and GitHub sends none — so unlike api/sync.py's
    # repo-creation path there is no request.app.state.repository dance to do.
    # Worth saying out loud, because the reader will expect that pattern.
    elif event_type == "deployment_status":
        await _handle_deployment_status(request.app, repo, project, payload)
    elif event_type == "workflow_run":
        _handle_workflow_run(repo, project, payload)

    return {"received": True, "matched": True}


def _is_web_url(candidate: str) -> bool:
    """True only for an absolute http(s) URL with a host.

    The scheme check is the load-bearing part. This value is stored and then
    rendered by the web app as an `<a href>` and an `<iframe src>`, so a
    `javascript:` (or `data:`) URL reported here would be script execution in
    the workspace's own origin, for every member who opens the project —
    stored XSS, delivered through a signed webhook.

    Deliberately separate from the SSRF guard on the probe: that one decides
    whether *we* may fetch a URL, and it does not run on the storage path at
    all. A probe that declines still stores whatever it was given.
    """
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def _trusted_environment_url(app, project, template, reported: str | None) -> str | None:
    """The URL to record for a deploy, or None.

    A workflow reports its own `environment_url`, and a workflow is editable
    by anyone with push access to the project repo. Two separate questions
    follow, and both have to be answered here rather than at render time.

    Is it even a web URL? Anything that is not absolute http(s) is refused
    outright, whatever the template — see `_is_web_url`.

    Is it *our* preview? For a template whose URL the platform mints we know
    what it should be, so a reported URL outside that prefix is not a preview
    we provisioned, and recording it would let a repo pusher choose what the
    workspace's Preview tab embeds and what its project list links to.
    Providers that mint their own URLs (Vercel, Pages, Northflank) have no
    such expected value, so beyond the scheme check their reports are taken
    as given.
    """
    if not reported or template is None:
        reported = reported or None
        if reported is not None and not _is_web_url(reported):
            logger.warning("deploy reported a non-http(s) preview URL; ignoring it")
            return None
        return reported
    if not _is_web_url(reported):
        logger.warning(
            "deploy for project=%s reported a non-http(s) preview URL; ignoring it",
            project.id,
        )
        return None
    if template.url_kind != "platform":
        return reported

    expected = platform_r2_preview_url(app.state.settings, project.id, template.health_path)
    if not expected:
        return None
    base = expected.rsplit("/", 1)[0] + "/"
    if not reported.startswith(base):
        logger.warning(
            "deploy for project=%s reported a preview URL outside the provisioned "
            "prefix; ignoring it",
            project.id,
        )
        return None
    return reported


async def _handle_deployment_status(app, repo: Repository, project, payload: dict) -> None:
    """Record a deploy and update the project's current deployment view.

    Filtered to the preview environment on purpose: a repository that grows
    its own staging or production workflows must not start reporting those as
    the business user's preview.
    """
    event = parse_deployment_status_event(payload)
    if event is None or event.environment != PREVIEW_ENVIRONMENT:
        return

    config = project.deployment_config
    template = get_deployment_template(config.template_id) if config else None
    state = _DEPLOY_STATE_BY_GITHUB.get(event.state)
    if state is None:
        return

    url = _trusted_environment_url(app, project, template, event.environment_url)

    frame_policy = None
    if state == "live" and url:
        frame_policy = await _probe_frame_policy(url)

    repo.upsert_deployment(
        Deployment(
            workspace_id=project.workspace_id,
            project_id=project.id,
            provider=(template.provider if template else "unknown"),
            template_id=(config.template_id if config else "unknown"),
            external_key=event.external_key,
            state=state,
            url=url,
            commit_sha=event.commit_sha,
            ref=event.ref,
            run_url=event.log_url,
            error_code=None if state != "failed" else "deploy_failed",
            error_message=event.description if state == "failed" else None,
            frame_policy=frame_policy,
        )
    )
    _refresh_deployment_state(repo, project)


def _handle_workflow_run(repo: Repository, project, payload: dict) -> None:
    """Only terminal *failures* of the seeded workflow are recorded here.

    A successful run has already reported itself as a deployment carrying a
    URL, and duplicating it would fight that row for the project's current
    state. What `deployment_status` cannot tell us is that a build died
    before it ever posted a deployment — which is precisely the case that
    would otherwise look like a preview stuck "building" forever.
    """
    event = parse_workflow_run_event(payload)
    if event is None or event.workflow_path != WORKFLOW_PATH:
        return
    if event.status != "completed" or event.conclusion in (None, "success", "skipped"):
        return

    config = project.deployment_config
    template = get_deployment_template(config.template_id) if config else None
    repo.upsert_deployment(
        Deployment(
            workspace_id=project.workspace_id,
            project_id=project.id,
            provider=(template.provider if template else "unknown"),
            template_id=(config.template_id if config else "unknown"),
            external_key=event.external_key,
            state="failed",
            # No url: a failed build produced nothing to look at. The
            # project's last-known-good url is preserved separately, in
            # _refresh_deployment_state.
            commit_sha=event.commit_sha,
            ref=event.ref,
            run_url=event.run_url,
            error_code="build_failed",
            error_message=f"workflow run {event.conclusion}",
        )
    )
    _refresh_deployment_state(repo, project)


# The probe below fetches a URL that arrived in a webhook payload. The
# delivery is HMAC-verified, but `environment_url` is written by the workflow
# — so anyone with push access to a project repo chooses it. Without these
# checks that is a server-side request forgery primitive into the cloud's own
# network, answered by a three-valued oracle (allow/deny/unknown) plus timing.
_PROBE_TIMEOUT_S = 5


def _probe_target_is_public(url: str) -> bool:
    """True only for an http(s) URL whose hostname resolves entirely to
    public addresses.

    Every resolved address is checked, not just the first: a hostname with
    both a public and a loopback record would otherwise pass and then connect
    to whichever the client picked.

    Residual risk, stated rather than hidden: this is a resolve-then-connect
    check, so a hostname that answers differently on the second lookup (DNS
    rebinding) can still slip past. Closing that needs the connection pinned
    to the address checked here, or an egress proxy enforcing the rule at the
    network layer — the latter is the right answer in production and is
    recorded in docs/DEPLOYMENT.md.
    """
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False

    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 0, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, ValueError):
        return False
    if not infos:
        return False

    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return False
    return True


async def _probe_frame_policy(url: str) -> str:
    """allow | deny | unknown, measured from the deployed app's own response.

    This exists because the browser cannot answer it. A cross-origin iframe
    hides its response headers, its document and its location; a refused
    frame still fires `load` and never fires `error`. The server has no such
    restriction, so the one honest reading of "will this embed" is taken
    here, once per successful deploy, and stored.

    Best-effort by design — a probe failure records "unknown", which the web
    app treats as "show the embed but keep the link prominent", not as a
    refusal. That is also what makes the SSRF guard free: refusing to probe
    costs nothing but a fallback to the link card.
    """
    # Resolution is a blocking syscall; off-thread so a slow or hostile
    # resolver cannot stall the event loop this webhook route shares.
    if not await asyncio.to_thread(_probe_target_is_public, url):
        logger.warning("refusing to probe a non-public preview URL")
        return "unknown"

    try:
        # No redirects. A frame-policy probe has no reason to follow one, and
        # following would re-open the SSRF hole this function just closed —
        # the guard above validates the URL we were given, not wherever a
        # Location header points. A host that redirects simply reads as
        # "unknown", which is the honest answer: we did not see its headers.
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_S, follow_redirects=False) as client:
            resp = await client.head(url)
            if resp.status_code >= 400:
                # Some static hosts refuse HEAD but serve GET. One retry
                # rather than recording a wrong answer.
                resp = await client.get(url)
    except Exception:  # noqa: BLE001 - an unreachable preview is not an error here
        return "unknown"

    if resp.is_redirect:
        return "unknown"

    xfo = (resp.headers.get("x-frame-options") or "").strip().lower()
    if xfo in ("deny", "sameorigin"):
        return "deny"
    csp = (resp.headers.get("content-security-policy") or "").lower()
    if "frame-ancestors" in csp:
        directive = csp.split("frame-ancestors", 1)[1].split(";", 1)[0]
        if "'none'" in directive:
            return "deny"
        # A frame-ancestors that names origins may or may not include ours.
        # "allow" here would be a guess; the postMessage handshake in the web
        # app is what settles it.
        return "unknown"
    return "allow"


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
