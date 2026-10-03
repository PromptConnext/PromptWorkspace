"""Resolving a workspace's deployment-provider credential (ADR 0021).

The counterpart to `github_auth.py`, and shaped the same way for the same
reason: several call sites need "the deploy credential for this workspace",
and the decrypt-and-shape dance belongs in one place.

Three kinds of provider, and the differences matter:

  Customer-owned (Vercel, Cloudflare Pages, Northflank). A workspace admin
  connects a token; it is verified against the provider before storage, held
  as ciphertext in `Workspace.integration_config["<provider>"]` exactly like
  the GitHub PAT, and sealed into the project repo at creation.

  Platform-owned (`platform-r2`). There is no customer account. The platform
  holds one account-wide credential in settings and **mints a per-workspace,
  bucket-scoped credential** from it; only the minted one ever reaches a
  repository. This asymmetry is deliberate: a repository secret is readable
  by anyone who can push to that repository, so sealing the platform's own
  account-wide key into customer repos would make one leak a cross-tenant
  incident rather than a single-workspace one.

  Host-owned (`github-pages`). No credential exists anywhere in this service.
  The git host hands each workflow run an ephemeral token scoped to the
  repository it runs in, and the deploy uses that. It is the cheapest posture
  we can offer — no account, no secret to seal, nothing to rotate — and the
  reason it is not simply "platform-owned with no minting" is that PromptWorkspace
  is not the one hosting the result.

`actions_secrets`/`actions_vars` are the seam that keeps templates and
providers independent. A template declares the *names* its workflow reads
(SecretSpec/VarSpec in app/deployments/registry.py); the provider decides
what goes in them. Adding a provider is one entry in PROVIDERS.
"""

from __future__ import annotations

import logging
import re
import secrets as _secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from app.models.schemas import Workspace

logger = logging.getLogger("promptworkspace.deploy")

PLATFORM_R2 = "platform-r2"
GITHUB_PAGES = "github-pages"
VERCEL = "vercel"
SSH_DOCKER = "ssh-docker"


class ProviderCredentialError(RuntimeError):
    """The provider credential exists but cannot be used to provision. Carries
    a `detail` code the router maps straight onto an HTTP response, matching
    the snake_case-code convention every other router uses."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class CredentialField:
    name: str
    label: str
    secret: bool = False
    # "workspace" — belongs to the account the token belongs to, typed once in
    # workspace settings (a Fly organisation, a Vercel team).
    # "project" — names the provider-side resource ONE PromptWorkspace project
    # deploys to (a Fly app, a Vercel project), so it is chosen per project in
    # the Planner and frozen into DeploymentConfig at repo creation.
    #
    # The distinction exists because a workspace has many projects and a
    # provider-side project holds exactly one deployment: storing it on the
    # workspace credential made every project in a workspace deploy over the
    # top of the previous one. See ADR 0025.
    scope: str = "workspace"


@dataclass(frozen=True)
class DeployProvider:
    id: str
    label: str
    # Non-secret identifiers an admin supplies alongside the token.
    fields: tuple[CredentialField, ...] = ()
    # Who owns the credential this provider deploys with. Three values, not a
    # boolean, because there are three honest answers (ADR 0023's amendment):
    #
    #   "customer" a workspace admin connects a token they got from a vendor.
    #   "platform" the cloud is the provider and mints a scoped credential per
    #              workspace; nothing to connect, and PromptWorkspace is hosting.
    #   "host"     the git host hands the workflow an ephemeral token of its
    #              own; nothing to connect, and PromptWorkspace is NOT hosting.
    #
    # Calling the last one "platform" would tell the picker to say "managed by
    # PromptWorkspace", which is not who is serving the site; calling it "customer"
    # would send an admin to a connect form with no fields.
    credential_owner: str = "customer"
    # What the provider's primary secret is called, and whether it spans more
    # than one line. Both exist so the connection form stays generic: an SSH
    # private key pasted into a single-line input loses its newlines and is
    # then rejected on the first deploy, far from where it was typed.
    token_label: str = "Deploy token"
    token_multiline: bool = False
    # Verifies the WORKSPACE half — the token and the account it can reach.
    verify: Callable[[Any, dict], Awaitable[dict]] | None = None
    # Verifies the PROJECT half — that the provider-side project a Tech Lead
    # named actually exists under that token. Separate from `verify` because
    # the two are supplied at different times by different people, and an
    # error about a missing project is only actionable where the project was
    # named. Receives the merged {token, **workspace values, **project values}.
    verify_project: Callable[[Any, dict], Awaitable[dict]] | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


def workspace_fields(provider: DeployProvider) -> tuple[CredentialField, ...]:
    return tuple(f for f in provider.fields if f.scope != "project")


def project_fields(provider: DeployProvider) -> tuple[CredentialField, ...]:
    return tuple(f for f in provider.fields if f.scope == "project")


def _vercel_team_params(config: dict) -> dict:
    # Omitted entirely rather than sent blank: a personal-account request
    # rejects an empty teamId.
    return {"teamId": config["org_id"]} if config.get("org_id") else {}


async def _vercel_get(config: dict, path: str, params: dict):
    import httpx

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            return await client.get(
                f"https://api.vercel.com{path}",
                params=params,
                headers={"Authorization": f"Bearer {config.get('token') or ''}"},
            )
    except Exception as exc:  # noqa: BLE001 - transport failures included
        raise ProviderCredentialError("deployment_provider_unreachable") from exc


async def verify_vercel_token(app, config: dict) -> dict:
    """Confirm the token can reach the team, before we store it.

    Deliberately does NOT check a project: which Vercel project a build goes
    to is chosen per PromptWorkspace project, not per workspace (ADR 0025), so
    at connect time there is no project to check yet. Listing under the team
    is the most this half can honestly assert.
    """
    resp = await _vercel_get(config, "/v9/projects", {**_vercel_team_params(config), "limit": "1"})
    if resp.status_code in (401, 403):
        raise ProviderCredentialError("deploy_token_rejected")
    if resp.is_error:
        raise ProviderCredentialError("deployment_provider_unreachable")
    return {}


async def verify_vercel_project(app, config: dict) -> dict:
    """Confirm the named Vercel project exists under the stored token.

    Run where the Tech Lead names it, which is the only place the answer is
    actionable: nothing in the pipeline creates a Vercel project, so a valid
    token aimed at a project that does not exist is otherwise indistinguishable
    from a bad token, and only surfaces at repository creation.
    """
    project_id = config.get("project_id") or ""
    resp = await _vercel_get(
        config, f"/v9/projects/{project_id}", _vercel_team_params(config)
    )
    if resp.status_code in (401, 403):
        raise ProviderCredentialError("deploy_token_rejected")
    if resp.status_code == 404:
        raise ProviderCredentialError("deploy_project_not_found")
    if resp.is_error:
        raise ProviderCredentialError("deployment_provider_unreachable")
    return {}


_PRIVATE_KEY_HEADER = "-----BEGIN "
_SSH_KEY_TYPES = ("ssh-", "ecdsa-", "sk-ssh-", "sk-ecdsa-")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}$")


async def verify_ssh_docker_host(app, config: dict) -> dict:
    """Confirm the Docker host is reachable and the admin gave us a usable key
    and host key, before we store any of it.

    Deliberately weaker than the other providers' verification, and worth
    being explicit about: this opens a TCP connection and checks the shapes of
    two pasted strings. It does **not** prove the key is authorized on that
    host, because doing so would mean speaking SSH from this service — a new
    dependency and an outbound shell session from the cloud, which is a much
    larger thing than this check is worth. The honest guarantee is "the
    address answers and these two values are the right kind of thing"; a key
    the host rejects still surfaces on the project's first deploy, in the run
    log, where the failure names itself.
    """
    import asyncio

    key = (config.get("token") or "").strip()
    if _PRIVATE_KEY_HEADER not in key:
        # A public key pasted into the private-key field is the mistake this
        # catches, and it is a common one.
        raise ProviderCredentialError("deploy_token_rejected")

    known_hosts = (config.get("known_hosts") or "").strip()
    if not any(key_type in known_hosts for key_type in _SSH_KEY_TYPES):
        raise ProviderCredentialError("deploy_host_key_invalid")

    host = (config.get("host") or "").strip()
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(host, 22), timeout=10)
    except Exception as exc:  # noqa: BLE001 - DNS, refusal and timeout alike
        raise ProviderCredentialError("deployment_provider_unreachable") from exc
    writer.close()
    return {}


async def verify_ssh_docker_project(app, config: dict) -> dict:
    """Confirm this project's placement on the host is well formed.

    Entirely local — there is nothing to ask the provider, because the
    provider is a machine the customer administers. It runs at all because
    these three values reach a shell on that host through the seeded workflow,
    and because a bad preview URL is invisible until a stakeholder opens an
    empty Preview tab.
    """
    slug = (config.get("app_slug") or "").strip()
    if not _SLUG_RE.match(slug):
        # Also what keeps the value safe to interpolate into the seeded
        # workflow's `ssh` command line and into a Compose project name, which
        # is itself restricted to lowercase.
        raise ProviderCredentialError("deploy_app_slug_invalid")

    port = (config.get("host_port") or "").strip()
    if not port.isdigit() or not (1 <= int(port) <= 65535):
        raise ProviderCredentialError("deploy_host_port_invalid")

    url = (config.get("public_url") or "").strip()
    # HTTPS only, and this is not pedantry: the Preview tab is an HTTPS page,
    # and a browser refuses to frame an http:// application inside it. An
    # http:// URL here produces a preview that is empty for every viewer.
    if not url.startswith("https://") or len(url) <= len("https://"):
        raise ProviderCredentialError("deploy_public_url_must_be_https")
    return {}


PROVIDERS: dict[str, DeployProvider] = {
    PLATFORM_R2: DeployProvider(
        id=PLATFORM_R2,
        label="PromptWorkspace hosting",
        credential_owner="platform",
        notes=(
            "Managed by PromptWorkspace — nothing to connect, and no third-party "
            "account required.",
        ),
    ),
    GITHUB_PAGES: DeployProvider(
        id=GITHUB_PAGES,
        label="GitHub Pages",
        credential_owner="host",
        notes=(
            "Nothing to connect: the deploy runs on the token GitHub gives "
            "each workflow run, in the repository PromptWorkspace already created "
            "for the project.",
            "The workspace's GitHub connection is what creates that "
            "repository, and it is configured under the GitHub integration "
            "rather than here.",
        ),
    ),
    VERCEL: DeployProvider(
        id=VERCEL,
        label="Vercel",
        fields=(
            # One Vercel project holds one production deployment, so each
            # PromptWorkspace project names its own.
            CredentialField("project_id", "Vercel project ID", scope="project"),
            CredentialField("org_id", "Vercel team or personal account ID"),
        ),
        verify=verify_vercel_token,
        verify_project=verify_vercel_project,
        notes=(
            "Create a token under Account Settings → Tokens, scoped to the team "
            "below.",
            "Each project needs its own Vercel project, created once in the "
            "dashboard; its Project ID is named on the project's deployment "
            "template, not here.",
            "Deployment Protection must be off for a project's production "
            "domain, or its preview will show a Vercel sign-in page instead of "
            "the application.",
        ),
    ),
    SSH_DOCKER: DeployProvider(
        id=SSH_DOCKER,
        label="Docker host over SSH",
        token_label="SSH private key",
        token_multiline=True,
        fields=(
            CredentialField("host", "Docker host address"),
            CredentialField("ssh_user", "SSH user"),
            # Pasted rather than discovered on purpose. The seeded workflow
            # keeps StrictHostKeyChecking on, which is only worth anything if
            # the expected host key came from somewhere other than the
            # connection being checked — so it comes from a person who ran
            # `ssh-keyscan` against the machine they mean.
            CredentialField("known_hosts", "Host key line from `ssh-keyscan <host>`"),
            # One published port and one URL per project, because one host
            # runs several. Naming them on the workspace would make every
            # project in it fight over the same port — the defect ADR 0025
            # was written about, in a different provider's clothes.
            CredentialField("app_slug", "Application name on the host", scope="project"),
            CredentialField("host_port", "Published port on the host", scope="project"),
            CredentialField("public_url", "Public HTTPS URL for this project", scope="project"),
        ),
        verify=verify_ssh_docker_host,
        verify_project=verify_ssh_docker_project,
        notes=(
            "The key below is sealed into every repository this workspace "
            "deploys, and a repository secret is readable by anyone who can "
            "push. Treat it as shell access to this host: give it a dedicated, "
            "unprivileged user that can use Docker and nothing else, on a "
            "machine that runs previews only.",
            "The host must already run Docker Engine with the Compose plugin. "
            "Nothing here installs it.",
            "Get the host key line with `ssh-keyscan <host>` and paste one "
            "line of the output.",
            "Each project names its own port and URL on its deployment "
            "template, not here. Point them at whichever reverse proxy or "
            "certificate the host already uses — nothing in the pipeline "
            "issues one.",
        ),
    ),
}


def get_provider(provider_id: str) -> DeployProvider | None:
    return PROVIDERS.get(provider_id)


def provider_config(workspace: Workspace | None, provider_id: str) -> dict | None:
    """The workspace's stored block for a provider, or None when unconnected.

    Mirrors `github_auth.github_config`, including its refusal to accept a
    block with no `secret_ref` — a half-written credential is worse than an
    absent one, because it makes the workspace look connected.
    """
    if workspace is None:
        return None
    config = (workspace.integration_config or {}).get(provider_id)
    if not isinstance(config, dict) or not config.get("secret_ref"):
        return None
    return config


def resolve_provider_credential(
    app, workspace: Workspace | None, provider_id: str
) -> tuple[str, dict] | None:
    """(plaintext token, config), or None when unconfigured or undecryptable.

    Same "a broken credential reads as unconfigured" contract as
    `github_auth.resolve_token`: raising here would turn a rotated encryption
    key into a 500 on read paths that merely wanted to know whether a project
    could deploy.
    """
    config = provider_config(workspace, provider_id)
    if config is None:
        return None
    try:
        token = app.state.secret_store.decrypt(config["secret_ref"])
    except Exception:  # noqa: BLE001 - any decrypt failure is "unusable credential"
        logger.warning(
            "deploy credential (%s) for workspace=%s could not be decrypted",
            provider_id,
            getattr(workspace, "id", "?"),
        )
        return None
    if not token:
        return None
    return token, config


# --------------------------------------------------------------------------- #
# Platform-owned R2
# --------------------------------------------------------------------------- #
def platform_r2_bucket_name(workspace_id: str) -> str:
    """One preview bucket per workspace. Bucket-per-workspace rather than
    prefix-per-workspace in one shared bucket, because a bucket is the
    smallest thing a Cloudflare token can be scoped to — a shared bucket
    would mean every repo's credential could read and overwrite every other
    workspace's previews."""
    return f"pw-preview-{workspace_id}"


def platform_r2_preview_url(settings, project_id: str, health_path: str) -> str | None:
    base = (settings.deploy_r2_public_base_url or "").rstrip("/")
    if not base:
        return None
    return f"{base}/previews/{project_id}{health_path if health_path.startswith('/') else '/'}"


async def ensure_platform_r2_credential(app, workspace: Workspace) -> dict:
    """The per-workspace R2 credential this workspace's repos may be given,
    minting and persisting one on first use.

    Returns a plaintext dict — access key id, secret, bucket, endpoint —
    which the caller seals into a repository. The account-wide token in
    settings is never part of it.

    Raises `ProviderCredentialError("deployment_provider_not_configured")`
    when the platform has no R2 configuration at all, so repo creation fails
    fast and *before* any external mutation rather than seeding a pipeline
    that could never succeed.
    """
    settings = app.state.settings

    existing = resolve_provider_credential(app, workspace, PLATFORM_R2)
    if existing is not None:
        secret_value, config = existing
        return {
            "access_key_id": config.get("access_key_id", ""),
            "secret_access_key": secret_value,
            "bucket": config.get("bucket", ""),
            "endpoint": config.get("endpoint", ""),
        }

    if settings.deploy_r2_allow_shared_key:
        # Dev only. Guarded by an explicit setting rather than by inference,
        # so nobody reaches this path by forgetting to configure minting.
        if not settings.deploy_r2_shared_access_key_id:
            raise ProviderCredentialError("deployment_provider_not_configured")
        logger.warning(
            "using the SHARED platform R2 key for workspace=%s — dev only; a leak "
            "from any one repository reaches every workspace's previews",
            workspace.id,
        )
        return {
            "access_key_id": settings.deploy_r2_shared_access_key_id,
            "secret_access_key": settings.deploy_r2_shared_secret_access_key,
            "bucket": settings.deploy_r2_shared_bucket,
            "endpoint": settings.deploy_r2_endpoint,
        }

    # Asks whether a minting client exists rather than whether a token is
    # set: main.py wires a real client when the platform is configured and a
    # network-free one for dev/test, and `None` is how an unconfigured
    # production deployment refuses. Checking the setting here instead would
    # make the dev client unreachable.
    r2_client = getattr(app.state, "r2_client", None)
    if r2_client is None:
        raise ProviderCredentialError("deployment_provider_not_configured")

    minted = await r2_client.mint_workspace_credential(
        account_id=settings.deploy_r2_account_id,
        api_token=settings.deploy_r2_api_token,
        bucket=platform_r2_bucket_name(workspace.id),
        label=f"promptworkspace-preview-{workspace.id}",
    )

    # Persist the minted credential the same way a customer-supplied one is
    # persisted: ciphertext in integration_config, non-secret identifiers
    # beside it. Reused for every later project in this workspace, so a
    # workspace accumulates one preview credential, not one per repo.
    merged = dict(workspace.integration_config or {})
    merged[PLATFORM_R2] = {
        "auth_kind": "minted_s3_key",
        "access_key_id": minted["access_key_id"],
        "bucket": minted["bucket"],
        "endpoint": minted["endpoint"],
        "secret_ref": app.state.secret_store.encrypt(minted["secret_access_key"]),
        "connected_by": "platform",
    }
    app.state.repository.update_workspace(workspace.id, integration_config=merged)
    return minted


class CloudflareR2Client:
    """Mints bucket-scoped R2 credentials from the platform's account token.

    Split behind `app.state.r2_client` so tests substitute a fake, exactly as
    they already do for `app.state.github_client`. Kept deliberately thin:
    this is the only place the platform's account-wide token is used, and it
    is not a general Cloudflare client.
    """

    API = "https://api.cloudflare.com/client/v4"

    async def mint_workspace_credential(
        self, *, account_id: str, api_token: str, bucket: str, label: str
    ) -> dict:
        import httpx

        headers = {"Authorization": f"Bearer {api_token}"}
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                created = await client.post(
                    f"{self.API}/accounts/{account_id}/r2/buckets",
                    headers=headers,
                    json={"name": bucket},
                )
                # 409 means the bucket already exists, which is the normal
                # answer on every provisioning after the first.
                if created.is_error and created.status_code != 409:
                    raise ProviderCredentialError("deployment_provider_bucket_failed")

                token = await client.post(
                    f"{self.API}/accounts/{account_id}/r2/temp-access-tokens",
                    headers=headers,
                    json={
                        "bucket": bucket,
                        "parentAccessKeyId": "",
                        "permission": "object-read-write",
                        "ttlSeconds": 0,
                        "label": label,
                    },
                )
                if token.is_error:
                    raise ProviderCredentialError("deployment_provider_token_failed")
                result = (token.json() or {}).get("result") or {}
        except ProviderCredentialError:
            raise
        except Exception as exc:  # noqa: BLE001 - transport failures included
            raise ProviderCredentialError("deployment_provider_unreachable") from exc

        access_key_id = result.get("accessKeyId")
        secret_access_key = result.get("secretAccessKey")
        if not access_key_id or not secret_access_key:
            raise ProviderCredentialError("deployment_provider_token_failed")
        return {
            "access_key_id": access_key_id,
            "secret_access_key": secret_access_key,
            "bucket": bucket,
            "endpoint": f"https://{account_id}.r2.cloudflarestorage.com",
        }


class FakeR2Client:
    """Network-free minting for tests and for `data_backend=memory` runs."""

    def __init__(self) -> None:
        self.minted: list[dict] = []
        self.fail_with: str | None = None

    async def mint_workspace_credential(
        self, *, account_id: str, api_token: str, bucket: str, label: str
    ) -> dict:
        if self.fail_with:
            raise ProviderCredentialError(self.fail_with)
        record = {
            "access_key_id": f"fake-key-{_secrets.token_hex(4)}",
            "secret_access_key": f"fake-secret-{_secrets.token_hex(8)}",
            "bucket": bucket,
            "endpoint": f"https://{account_id or 'fake'}.r2.cloudflarestorage.com",
        }
        self.minted.append({**record, "label": label})
        return record
