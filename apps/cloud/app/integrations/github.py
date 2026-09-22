"""Git-host integration (M11): PR + push webhook parsing, repo creation and
seeding, and fetch-on-demand file content.

Doesn't fit app/integrations/tracker.py's TrackerAdapter protocol — that's
shaped around pmo-field task mirroring (InboundUpdate.status/assignee/
sprint). GitHub's events (PR opened/merged, push) drive indexing, not field
updates, so this module and app/api/github.py stand on their own rather than
distorting the Jira/ClickUp registry to fit.

Auth is a **per-workspace fine-grained Personal Access Token**, supplied by a
workspace admin and held as ciphertext (`secret_ref`) in the workspace's
integration config — the same secret-store treatment as workspace-BYO model
keys (app/secrets.py, ADR 0011). This replaces the platform-wide GitHub App
the module originally shipped with; see ADR 0017's amendment for why.

Two consequences worth keeping in mind:

- The token *is* the workspace's own credential, so there is no installation
  id to forge — the cross-tenant hazard of the App design (issue #3) cannot
  arise. A workspace can only ever reach what its own token can reach.
- The token is long-lived and belongs to a person. `verify_token()` records
  its expiry so the settings UI can warn before it lapses, and every call
  path degrades to "not configured" rather than erroring when it is gone.

Webhooks are likewise per-repository: `create_repo_webhook()` registers one
at repo-creation time with a freshly generated secret, stored (encrypted)
alongside the project. There is no shared platform signing secret, so a
delivery can only be attributed to the project whose secret validates it.

ADR 0021 adds the deployment half: the same hook also carries `workflow_run`
and `deployment_status`, and this module gains the three writes that make a
seeded CI pipeline work — a single-commit tree write (`create_commit_with_
files`), sealed-box Actions secrets, and plaintext Actions variables.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import posixpath
import secrets
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

import httpx

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.integrations.repo_seed import SeedFile

GITHUB_API = "https://api.github.com"

# The one list of events every repo hook subscribes to. Named because it now
# has three consumers — registration, the inbound dispatch in
# app/api/github.py, and the repair path that fixes repos created before
# ADR 0021 — and three copies is how they would drift apart.
#
# `deployment_status` is the only event carrying a deployed URL.
# `workflow_run` is the only one that fires when a build dies *before* it
# posts a deployment; without it a broken build looks like a preview that is
# eternally "building".
WEBHOOK_EVENTS = ["push", "pull_request", "workflow_run", "deployment_status"]

# How many blob uploads run at once inside create_commit_with_files. Blobs are
# independent, so this is what keeps a 40-file scaffold to a few seconds
# instead of 40 serial round-trips; kept modest to stay well inside GitHub's
# secondary rate limits for concurrent writes.
_BLOB_CONCURRENCY = 8


def verify_signature(body: bytes, signature: str | None, secret: str) -> bool:
    """GitHub signs the raw request body as HMAC-SHA256, sent as
    `X-Hub-Signature-256: sha256=<hex>`."""
    if not signature or not secret:
        return False
    prefix = "sha256="
    if not signature.startswith(prefix):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature[len(prefix) :])


def new_webhook_secret() -> str:
    """Signing secret for one repository's webhook. Generated per repo at
    creation time — there is no platform-wide secret to share, so a delivery
    that validates against a project's secret provably belongs to it."""
    return secrets.token_hex(32)


@dataclass(frozen=True)
class TokenIdentity:
    """What a supplied PAT turns out to be, established by verify_token()
    before anything is persisted."""

    login: str
    expires_at: str | None  # ISO-8601, or None for a token with no expiry
    can_access_owner: bool
    # "Organization" or "User" — decides whether a new repo is created via
    # POST /orgs/{owner}/repos or POST /user/repos. A solo workspace pointing
    # at a personal account is a normal case, not an edge one.
    owner_type: str = "Organization"


@dataclass(frozen=True)
class PullRequestEvent:
    number: int
    title: str
    body: str
    html_url: str
    head_sha: str
    merged: bool


def parse_pull_request_event(payload: dict) -> PullRequestEvent | None:
    """Only opened and merged PRs are indexed — a `closed` action with
    `merged: false` (abandoned PR) is ignored."""
    action = payload.get("action")
    pr = payload.get("pull_request") or {}
    if action == "opened":
        pass
    elif action == "closed" and pr.get("merged"):
        pass
    else:
        return None
    if not pr.get("number"):
        return None
    return PullRequestEvent(
        number=pr["number"],
        title=pr.get("title") or "",
        body=pr.get("body") or "",
        html_url=pr.get("html_url") or "",
        head_sha=(pr.get("head") or {}).get("sha") or "",
        merged=bool(pr.get("merged")),
    )


@dataclass(frozen=True)
class PushCommit:
    """One commit in a push delivery. `subject` is the first line only — the
    same thing the extension reads, and scanning the body would match issue
    references and quoted revert text."""

    sha: str
    subject: str
    url: str


@dataclass(frozen=True)
class PushEvent:
    after_sha: str
    changed_paths: list[str] = field(default_factory=list)
    removed_paths: list[str] = field(default_factory=list)
    # ADR 0023: the same delivery that drives RAG re-indexing also carries the
    # subjects attribution is read from. One event, two readers.
    commits: list[PushCommit] = field(default_factory=list)


def parse_push_event(payload: dict, default_branch: str) -> PushEvent | None:
    """Only pushes to the workspace's configured default branch trigger
    (re)indexing. Later commits in the same push win over earlier ones for a
    given path — a file added then removed within one push ends up removed."""
    if payload.get("ref") != f"refs/heads/{default_branch}":
        return None
    after_sha = payload.get("after") or ""
    if not after_sha:
        return None

    path_action: dict[str, str] = {}
    commits: list[PushCommit] = []
    for commit in payload.get("commits") or []:
        sha = commit.get("id") or ""
        if sha:
            commits.append(
                PushCommit(
                    sha=sha,
                    subject=(commit.get("message") or "").split("\n", 1)[0],
                    url=commit.get("url") or "",
                )
            )
        for path in commit.get("added") or []:
            path_action[path] = "changed"
        for path in commit.get("modified") or []:
            path_action[path] = "changed"
        for path in commit.get("removed") or []:
            path_action[path] = "removed"

    changed = [p for p, a in path_action.items() if a == "changed"]
    removed = [p for p, a in path_action.items() if a == "removed"]
    return PushEvent(
        after_sha=after_sha, changed_paths=changed, removed_paths=removed, commits=commits
    )


@dataclass(frozen=True)
class DeploymentStatusEvent:
    """A `deployment_status` delivery for the preview environment (ADR 0021).

    `external_key` is GitHub's deployment id as a string. It is the
    idempotency key for `pz_deployments`, and it has to be: one deploy emits
    several of these (`in_progress`, then `success` or `failure`), so without
    a stable key each delivery would insert a duplicate row.
    """

    external_key: str
    state: str  # queued | in_progress | success | failure | error | inactive
    environment: str
    environment_url: str | None
    commit_sha: str | None
    ref: str | None
    log_url: str | None
    description: str | None


def parse_deployment_status_event(payload: dict) -> DeploymentStatusEvent | None:
    status = payload.get("deployment_status") or {}
    deployment = payload.get("deployment") or {}
    deployment_id = deployment.get("id")
    state = status.get("state")
    if deployment_id is None or not state:
        return None
    url = status.get("environment_url") or None
    return DeploymentStatusEvent(
        external_key=str(deployment_id),
        state=str(state),
        # The environment is read from the status first: a deploy may be
        # re-targeted mid-flight, and the status is the newer of the two.
        environment=str(status.get("environment") or deployment.get("environment") or ""),
        environment_url=url,
        commit_sha=deployment.get("sha") or None,
        ref=deployment.get("ref") or None,
        log_url=status.get("log_url") or status.get("target_url") or None,
        description=status.get("description") or None,
    )


@dataclass(frozen=True)
class WorkflowRunEvent:
    """A `workflow_run` delivery. Only terminal, non-success runs are
    interesting: a successful run already reported itself as a deployment
    with a URL, and duplicating it here would fight that row for the same
    project's current state."""

    external_key: str
    workflow_path: str
    status: str  # queued | in_progress | completed
    conclusion: str | None  # success | failure | cancelled | timed_out | ...
    commit_sha: str | None
    ref: str | None
    run_url: str | None


def parse_workflow_run_event(payload: dict) -> WorkflowRunEvent | None:
    run = payload.get("workflow_run") or {}
    run_id = run.get("id")
    if run_id is None:
        return None
    return WorkflowRunEvent(
        external_key=f"run-{run_id}",
        workflow_path=str(run.get("path") or ""),
        status=str(run.get("status") or ""),
        conclusion=run.get("conclusion") or None,
        commit_sha=run.get("head_sha") or None,
        ref=run.get("head_branch") or None,
        run_url=run.get("html_url") or None,
    )


def _is_not_fast_forward(body: str) -> bool:
    """GitHub's wording for a ref update that lost a race."""
    normalized = body.lower().replace("-", " ")
    return "not a fast forward" in normalized


class GithubWriteError(RuntimeError):
    """A GitHub write call (repo create / file commit) failed. `sync.py`
    catches this instead of importing httpx directly, keeping the API layer
    ignorant of the HTTP client this module happens to use.

    Carries `status_code` when the failure came from a response, because the
    remedy differs sharply by status — a 403/404 on a repo we just created is
    a token-scope problem the admin must fix, while a 5xx is "try again".
    `None` for failures with no response behind them.
    """

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class GithubBranchMovedError(GithubWriteError):
    """The branch a seed commit was going to land on is no longer at the
    commit the caller inspected (plan 0027). The no-overwrite check was made
    against that commit's tree, so committing on top of anything else could
    replace a file the check never saw — the caller refuses instead."""


class GithubRefUpdateRejectedError(GithubWriteError):
    """GitHub refused to move the branch for a reason other than a lost race
    — a protected branch or a ruleset requiring a pull request, most often.
    Kept apart from `GithubBranchMovedError` because the remedies differ: a
    moved branch clears on retry, a protected one refuses every retry until
    the protection changes."""


class GithubAuthError(GithubWriteError):
    """The supplied PAT was rejected (401/403). Distinguished from a generic
    write failure so the settings endpoint can answer 400 "bad token" rather
    than 502 "GitHub is unwell"."""


def _normalize_expiry(raw: str | None) -> str | None:
    """GitHub sends the expiry header as `2026-11-01 00:00:00 UTC`. Store it
    as ISO-8601 so the web app can parse it with `new Date(...)`; anything
    unrecognized is dropped rather than persisted in a shape nobody can read.
    """
    if not raw:
        return None
    from datetime import datetime, timezone

    for fmt in ("%Y-%m-%d %H:%M:%S %Z", "%Y-%m-%d %H:%M:%S UTC", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            parsed = datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc).isoformat()
    return None


async def ensure_hook_events(client, token: str, repo: str, callback_url: str) -> bool:
    """Make sure this repo's PromptZone hook is subscribed to WEBHOOK_EVENTS,
    widening it if not. True when a hook was found and is now correct.

    This is the only migration route for repositories created before ADR
    0021. Re-running `create_repo_webhook` cannot do it: that call swallows
    GitHub's 422 "a hook with this config already exists" as success, which
    is what makes repo-creation retries safe and what makes re-registration a
    silent no-op.

    Matching on `config.url` rather than on the first hook: a repository may
    carry hooks belonging to CI providers, chat integrations or the customer
    themselves, and widening one of those would be someone else's outage.
    """
    hooks = await client.list_repo_hooks(token, repo)
    wanted = set(WEBHOOK_EVENTS)
    for hook in hooks:
        if (hook.get("config") or {}).get("url") != callback_url:
            continue
        if wanted.issubset(set(hook.get("events") or [])):
            return True
        await client.update_repo_hook(token, repo, hook["id"], list(WEBHOOK_EVENTS))
        return True
    return False


def _seal_secret(public_key_b64: str, value: str) -> str:
    """libsodium sealed box (`crypto_box_seal`) of `value` against a repo's
    Actions public key, base64-encoded — the only form GitHub accepts for a
    secret value.

    Imported lazily, matching app/secrets.py's treatment of `cryptography`:
    a deployment that never seeds a repo should not need the wheel present
    to import this module.
    """
    from nacl.encoding import Base64Encoder
    from nacl.public import PublicKey, SealedBox

    sealed = SealedBox(PublicKey(public_key_b64.encode(), Base64Encoder)).encrypt(
        value.encode("utf-8")
    )
    return base64.b64encode(sealed).decode("ascii")


class RepoAlreadyExistsError(GithubWriteError):
    """`create_org_repo` got a 422 "name already exists" — the caller
    decides whether to adopt the existing repo (retry after a partial
    failure) or surface `repo_name_taken`."""


class GithubClient(Protocol):
    async def verify_token(self, token: str, owner: str) -> TokenIdentity: ...

    async def create_repo_webhook(
        self, token: str, repo: str, callback_url: str, secret: str
    ) -> bool: ...

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str: ...

    async def create_org_repo(
        self,
        token: str,
        org: str,
        name: str,
        description: str,
        private: bool,
        owner_type: str = "Organization",
    ) -> dict: ...

    async def get_repo(self, token: str, repo: str) -> dict | None: ...

    async def get_branch_head(self, token: str, repo: str, branch: str) -> str: ...

    async def get_tree(self, token: str, repo: str, sha: str) -> tuple[list[str], bool]: ...

    async def get_tree_entries(
        self, token: str, repo: str, sha: str, *, recursive: bool = True
    ) -> tuple[list[dict], bool]: ...

    async def list_repos(
        self,
        token: str,
        owner: str,
        owner_type: str = "Organization",
        max_pages: int = 5,
    ) -> tuple[list[dict], bool]: ...

    async def put_file_content(
        self,
        token: str,
        repo: str,
        path: str,
        content: str,
        message: str,
        branch: str,
        sha: str | None = None,
    ) -> str: ...

    async def create_commit_with_files(
        self,
        token: str,
        repo: str,
        branch: str,
        files: list[SeedFile],
        message: str,
        expected_base_sha: str | None = None,
    ) -> str: ...

    async def put_actions_secret(self, token: str, repo: str, name: str, value: str) -> None: ...

    async def put_actions_variable(self, token: str, repo: str, name: str, value: str) -> None: ...

    async def list_repo_hooks(self, token: str, repo: str) -> list[dict]: ...

    async def update_repo_hook(
        self, token: str, repo: str, hook_id: int, events: list[str]
    ) -> None: ...

    async def rotate_repo_hook_secret(
        self,
        token: str,
        repo: str,
        hook_id: int,
        callback_url: str,
        secret: str,
        events: list[str],
    ) -> None: ...

    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None: ...

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None: ...

    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]: ...

    async def list_commits(
        self, token: str, repo: str, sha: str, limit: int = 100
    ) -> list[str]: ...


# GitHub caps `per_page` at 100 on both repository listings.
_REPO_PAGE_SIZE = 100


def _repo_row(data: dict) -> dict:
    """The subset of a GitHub repository object this service uses.

    `empty` is derived from `size`: GitHub exposes no "has no commits" flag,
    and a repository with no commits cannot be seeded at all — the seed step
    reads the branch head first, which 404s. Catching it at the picker turns a
    502 days later into a disabled row now. `size` is in KB and is eventually
    consistent, so treat `empty` as advisory, not as the guard.
    """
    return {
        # GitHub's stable numeric id — immutable across a rename or transfer,
        # unlike full_name. What a repo-collision check verifies identity
        # against (plan 0016); full_name alone is a lookup key.
        "id": data["id"],
        "full_name": data["full_name"],
        "name": data.get("name") or data["full_name"].split("/")[-1],
        "html_url": data["html_url"],
        "default_branch": data.get("default_branch", "main"),
        "private": bool(data.get("private", False)),
        "archived": bool(data.get("archived", False)),
        "empty": data.get("size", 1) == 0,
        "pushed_at": data.get("pushed_at"),
        # The project-specific description create_org_repo wrote at creation
        # (api/sync.py) — the only signal available to recognize "our earlier
        # attempt" in the crash window before repo_id is persisted.
        "description": data.get("description"),
    }


def _owned_by(row: dict, owner: str) -> bool:
    return row["full_name"].split("/")[0].lower() == owner.lower()


async def _send(method: str, url: str, *, token: str, what: str, **kwargs) -> httpx.Response:
    """One GitHub request, with transport failures (DNS, connect refused,
    read timeout) converted to `GithubWriteError`.

    Without this a slow GitHub turns into an httpx exception escaping the
    router as an opaque 500 — indistinguishable to the user from a bug, and
    unhandled by callers that carefully branch on `status_code`. A transport
    failure carries no status, so it lands on the "transient, try again"
    side of every one of those branches, which is exactly right.
    """
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            return await client.request(method, url, headers=headers, **kwargs)
    except httpx.HTTPError as exc:
        raise GithubWriteError(f"{what} failed: could not reach GitHub ({exc!r})") from exc


def _is_duplicate_webhook_response(resp: httpx.Response) -> bool:
    """Whether GitHub rejected a create because this hook already exists.

    ``POST /repos/{owner}/{repo}/hooks`` uses 422 for validation failures and
    secondary-rate limiting too. GitHub's duplicate response identifies the
    offending resource as ``Hook`` and says the hook already exists; requiring
    both fields keeps a malformed callback URL or a future event validation
    failure from being mistaken for an idempotent registration.
    """
    try:
        payload = resp.json()
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    errors = payload.get("errors")
    if not isinstance(errors, list):
        return False
    # A mixed response may also contain an actual validation failure. Treat it
    # as a failure rather than accepting a partial match and hiding that error.
    return len(errors) == 1 and isinstance(errors[0], dict) and (
        errors[0].get("resource") == "Hook"
        and errors[0].get("message") == "Hook already exists on this repository"
    )


class HttpGithubClient:
    async def verify_token(self, token: str, owner: str) -> TokenIdentity:
        """Prove the token works and can reach `owner`, before it is stored.

        GitHub reports a PAT's expiry only as a response *header*
        (`github-authentication-token-expiration`); there is no endpoint for
        it, and classic tokens without an expiry simply omit it.
        """
        me = await _send("GET", f"{GITHUB_API}/user", token=token, what="verify_token")
        if me.status_code in (401, 403):
            raise GithubAuthError("token_rejected")
        if me.is_error:
            raise GithubWriteError(f"verify_token failed: {me.status_code} {me.text}")
        login = me.json().get("login") or ""
        expires_at = me.headers.get("github-authentication-token-expiration")

        owner_type = "Organization"
        can_access_owner = False
        if owner.lower() == login.lower():
            owner_type, can_access_owner = "User", True
        else:
            org = await _send(
                "GET", f"{GITHUB_API}/orgs/{owner}", token=token, what="verify_token owner"
            )
            can_access_owner = org.status_code == 200

        return TokenIdentity(
            login=login,
            expires_at=_normalize_expiry(expires_at),
            can_access_owner=can_access_owner,
            owner_type=owner_type,
        )

    async def create_repo_webhook(
        self, token: str, repo: str, callback_url: str, secret: str
    ) -> bool:
        resp = await _send(
            "POST",
            f"{GITHUB_API}/repos/{repo}/hooks",
            token=token,
            what=f"create_repo_webhook for {repo}",
            json={
                "name": "web",
                "active": True,
                "events": list(WEBHOOK_EVENTS),
                "config": {
                    "url": callback_url,
                    "content_type": "json",
                    "secret": secret,
                    "insecure_ssl": "0",
                },
            },
        )
        # GitHub documents 422 as both validation failure and secondary-rate
        # limiting. Only its specific Hook-already-exists error is a safe
        # retry outcome; every other 422 must reach the caller as a failure.
        if resp.status_code == 422 and _is_duplicate_webhook_response(resp):
            return False
        if resp.is_error:
            raise GithubWriteError(
                f"create_repo_webhook failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        return True

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str:
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/contents/{path}",
            token=token,
            what=f"fetch_file_content for {repo}/{path}",
            params={"ref": sha},
        )
        if resp.is_error:
            raise GithubWriteError(
                f"fetch_file_content failed for {repo}/{path}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        data = resp.json()
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")

    async def create_org_repo(
        self,
        token: str,
        org: str,
        name: str,
        description: str,
        private: bool,
        owner_type: str = "Organization",
    ) -> dict:
        """`auto_init: true` is required — the contents API (used by
        `put_file_content`) cannot write into a zero-commit repo without
        blob/tree plumbing, so GitHub must create the initial commit.

        A personal-account owner takes `POST /user/repos` instead; the org
        endpoint 404s for a user login.
        """
        url = (
            f"{GITHUB_API}/user/repos"
            if owner_type == "User"
            else f"{GITHUB_API}/orgs/{org}/repos"
        )
        resp = await _send(
            "POST",
            url,
            token=token,
            what=f"create_org_repo {org}/{name}",
            json={
                "name": name,
                "description": description,
                "private": private,
                "auto_init": True,
            },
        )
        if resp.status_code == 422:
            raise RepoAlreadyExistsError(f"repo {org}/{name} already exists")
        if resp.is_error:
            raise GithubWriteError(
                f"create_org_repo failed: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        return _repo_row(resp.json())

    async def get_repo(self, token: str, repo: str) -> dict | None:
        """None means "no such repo" — every other failure raises, so the
        adopt-on-retry path in api/sync.py can tell "the name is taken by
        someone else" apart from "the token can't see the repo it just made"
        (a fine-grained PAT scoped to selected repositories does exactly that,
        and answers 403 rather than 404)."""
        resp = await _send(
            "GET", f"{GITHUB_API}/repos/{repo}", token=token, what=f"get_repo {repo}"
        )
        if resp.status_code == 404:
            return None
        if resp.is_error:
            raise GithubWriteError(
                f"get_repo failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        return _repo_row(resp.json())

    async def get_branch_head(self, token: str, repo: str, branch: str) -> str:
        """The commit sha at the tip of `branch` — what a repo snapshot pins
        itself to, and what the analysis staleness check compares against
        (plan 0027)."""
        head_sha, _ = await self._read_branch_head(token, repo, branch)
        return head_sha

    async def get_tree(self, token: str, repo: str, sha: str) -> tuple[list[str], bool]:
        """Every file path in the tree at `sha`, and whether GitHub truncated
        the listing. Directories and submodules are dropped: a snapshot and
        the code index both want files they can read, and a submodule's path
        cannot be read through the contents API. The no-overwrite check
        needs more than that and uses `get_tree_entries` instead.

        GitHub caps a recursive listing (100k entries / 7 MB) and says so with
        `truncated` rather than an error, so the flag is returned instead of
        raised — a partial listing of a very large repository is still a
        useful snapshot, as long as nobody mistakes it for the whole one."""
        entries, truncated = await self.get_tree_entries(token, repo, sha)
        return [e["path"] for e in entries if e["type"] == "blob"], truncated

    async def get_tree_entries(
        self, token: str, repo: str, sha: str, *, recursive: bool = True
    ) -> tuple[list[dict], bool]:
        """Every entry of the tree at `sha` — `{"path", "type", "sha"}` with
        type `blob`, `tree` or `commit` (a submodule's gitlink) — and whether
        GitHub truncated the listing. `sha` may be a commit or a tree.

        Non-recursive, `path` is the entry's name within that one directory
        and `sha` of a `tree` entry is what to list next; that is how the
        seed walks only the directories it would write into when a recursive
        listing came back truncated (app/api/sync.py::_existing_tree)."""
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/git/trees/{sha}",
            token=token,
            what=f"get_tree for {repo}",
            params={"recursive": "1"} if recursive else None,
        )
        if resp.is_error:
            raise GithubWriteError(
                f"get_tree failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        data = resp.json()
        entries = [
            {"path": entry["path"], "type": entry.get("type"), "sha": entry.get("sha")}
            for entry in data.get("tree", [])
            if entry.get("type") in ("blob", "tree", "commit")
        ]
        return entries, bool(data.get("truncated", False))

    async def list_repos(
        self,
        token: str,
        owner: str,
        owner_type: str = "Organization",
        max_pages: int = 5,
    ) -> tuple[list[dict], bool]:
        """Every repository under `owner` this token can see, newest push first.

        Returns `(repos, truncated)`. Capped rather than exhaustively paginated
        — `max_pages` x 100 is far past what a picker can usefully show, and a
        page shorter than `per_page` ends the walk, so the common case is one
        request.

        The results are filtered by `owner` here, not trusted from GitHub.
        A fine-grained PAT is scoped to a single resource owner, but
        `/user/repos` is documented in terms of the *user's* affiliations, and
        the consequence of letting a foreign-owner repo through is not a
        cosmetic one: the platform would accept an import it can never write
        to, and the failure would not surface until the seed commit days later.
        """
        collected: list[dict] = []
        truncated = False
        for page in range(1, max_pages + 1):
            resp = await _send(
                "GET",
                f"{GITHUB_API}/user/repos",
                token=token,
                what="list_repos",
                params={
                    "affiliation": "owner,organization_member",
                    "sort": "pushed",
                    "direction": "desc",
                    "per_page": _REPO_PAGE_SIZE,
                    "page": page,
                },
            )
            if resp.is_error:
                raise GithubWriteError(
                    f"list_repos failed for {owner}: {resp.status_code} {resp.text}",
                    status_code=resp.status_code,
                )
            batch = resp.json()
            collected.extend(batch)
            if len(batch) < _REPO_PAGE_SIZE:
                break
        else:
            truncated = True

        rows = [r for r in (_repo_row(raw) for raw in collected) if _owned_by(r, owner)]
        if rows or owner_type != "Organization":
            return rows, truncated

        # Nothing under the connected org came back. GitHub's own docs do not
        # promise that a token scoped to an organization surfaces that org's
        # repositories through the *user*-affiliation endpoint, so fall back to
        # the org listing rather than rendering an empty picker. One extra
        # request, and only in the case that would otherwise show nothing.
        resp = await _send(
            "GET",
            f"{GITHUB_API}/orgs/{owner}/repos",
            token=token,
            what="list_repos org fallback",
            params={"type": "all", "sort": "pushed", "per_page": _REPO_PAGE_SIZE},
        )
        if resp.status_code == 404:
            return [], False
        if resp.is_error:
            raise GithubWriteError(
                f"list_repos failed for {owner}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        org_rows = [r for r in (_repo_row(raw) for raw in resp.json()) if _owned_by(r, owner)]
        return org_rows, len(org_rows) == _REPO_PAGE_SIZE

    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None:
        """The newest status for one deployment, or None when GitHub has no
        such deployment (deleted, or never created by the run we recorded)."""
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/deployments/{deployment_id}/statuses?per_page=1",
            token=token,
            what="read a deployment's statuses",
        )
        if resp.status_code == 404:
            return None
        if resp.is_error:
            raise GithubWriteError(
                f"reading a deployment's statuses failed for {repo}: {resp.status_code}",
                status_code=resp.status_code,
            )
        rows = resp.json() or []
        return rows[0] if rows else None

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None:
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/actions/runs/{run_id}",
            token=token,
            what="read a workflow run",
        )
        if resp.status_code == 404:
            return None
        if resp.is_error:
            raise GithubWriteError(
                f"reading a workflow run failed for {repo}: {resp.status_code}",
                status_code=resp.status_code,
            )
        return resp.json()

    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]:
        """The shas between two commits, oldest first, excluding `base`."""
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/compare/{base}...{head}",
            token=token,
            what="compare two commits",
        )
        if resp.is_error:
            raise GithubWriteError(
                f"comparing two commits failed for {repo}: {resp.status_code}",
                status_code=resp.status_code,
            )
        return [c["sha"] for c in (resp.json() or {}).get("commits", []) if c.get("sha")]

    async def list_commits(self, token: str, repo: str, sha: str, limit: int = 100) -> list[str]:
        """The first page of history reachable from `sha`, newest first.

        Only used for a project's very first build, which has no previous
        successful deploy to compare against. Capped rather than paginated: a
        first build reaches back to the seed commit, and a repository whose
        first deploy carries more than a hundred commits is one whose history
        predates PromptZone entirely."""
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/commits?sha={sha}&per_page={min(limit, 100)}",
            token=token,
            what="list commits",
        )
        if resp.is_error:
            raise GithubWriteError(
                f"listing commits failed for {repo}: {resp.status_code}",
                status_code=resp.status_code,
            )
        return [c["sha"] for c in (resp.json() or []) if c.get("sha")]

    async def put_file_content(
        self,
        token: str,
        repo: str,
        path: str,
        content: str,
        message: str,
        branch: str,
        sha: str | None = None,
    ) -> str:
        """Upsert, not create. GitHub's contents API rejects a PUT over an
        existing path with 422 unless the caller supplies that blob's `sha`,
        so an unsupplied sha is resolved here first. This is load-bearing at
        repo creation: repos are made with `auto_init=true`, which means
        GitHub has *already* written README.md before the first seed file
        lands — writing it blind 422s, and a 422 is neither a token-scope
        error nor transient, so the caller's retry would loop forever."""
        body: dict = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch": branch,
        }
        if sha is None:
            sha = await self._get_file_sha(token, repo, path, branch)
        if sha is not None:
            body["sha"] = sha
        resp = await _send(
            "PUT",
            f"{GITHUB_API}/repos/{repo}/contents/{path}",
            token=token,
            what=f"put_file_content for {repo}/{path}",
            json=body,
        )
        if resp.is_error:
            raise GithubWriteError(
                f"put_file_content failed for {repo}/{path}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        data = resp.json()
        return data["content"]["sha"]

    async def create_commit_with_files(
        self,
        token: str,
        repo: str,
        branch: str,
        files: list[SeedFile],
        message: str,
        expected_base_sha: str | None = None,
    ) -> str:
        """Write every seed file as ONE commit, through the Git Data API.

        `put_file_content` is the right primitive for one file and the wrong
        one for a scaffold: it costs two round-trips and one commit each, so
        a forty-file template would mean eighty serial requests inside a
        single HTTP request and forty junk commits — and a failure partway
        leaves a repo that looks seeded with no workflow in it.

        Here, only the final ref update is observable. Blobs, the tree and
        the commit are all built without moving the branch, so a crash before
        that last call leaves dangling objects GitHub garbage-collects and a
        branch that never moved. That is what shrinks ADR 0017's partial-seed
        window from "N files" to one atomic reference update, and it is what
        makes the adopt-on-retry path in api/sync.py actually true rather
        than merely hoped for.

        Never force-pushes: a non-fast-forward means someone else moved the
        branch, which is a transient conflict to retry, not something to
        overwrite.

        `expected_base_sha` pins the parent to a commit the caller already
        inspected (plan 0027: the no-overwrite check read that commit's
        tree). If the branch has moved off it, by the time of this read or of
        the final ref update, `GithubBranchMovedError` is raised and nothing
        is committed — a push landing between the check and this write could
        otherwise add a file the new tree then replaces.

        A 422 on the ref update is read by its message, pinned or not: "not a
        fast forward" is a lost race (`GithubBranchMovedError`, retryable);
        anything else — branch protection, a ruleset — is
        `GithubRefUpdateRejectedError`, which no retry clears.
        """
        if not files:
            raise GithubWriteError("create_commit_with_files called with no files")

        base_sha, base_tree = await self._read_branch_head(token, repo, branch)
        if expected_base_sha is not None and base_sha != expected_base_sha:
            raise GithubBranchMovedError(
                f"{repo}@{branch} moved from {expected_base_sha} to {base_sha}", status_code=409
            )

        # Blobs are independent of each other and of the tree, so they go out
        # concurrently — this is the whole reason a large scaffold stays fast.
        semaphore = asyncio.Semaphore(_BLOB_CONCURRENCY)

        async def upload(seed_file: SeedFile) -> dict:
            async with semaphore:
                blob_sha = await self._create_blob(token, repo, seed_file.content)
            return {
                "path": seed_file.path,
                "mode": "100755" if getattr(seed_file, "executable", False) else "100644",
                "type": "blob",
                "sha": blob_sha,
            }

        tree_entries = list(await asyncio.gather(*(upload(f) for f in files)))

        tree_resp = await _send(
            "POST",
            f"{GITHUB_API}/repos/{repo}/git/trees",
            token=token,
            what=f"create_tree for {repo}",
            json={"base_tree": base_tree, "tree": tree_entries},
        )
        if tree_resp.is_error:
            raise GithubWriteError(
                f"create_tree failed for {repo}: {tree_resp.status_code} {tree_resp.text}",
                status_code=tree_resp.status_code,
            )
        tree_sha = tree_resp.json()["sha"]

        # A genuine retry that correctly adopts the same repository (plan
        # 0016) would otherwise recommit byte-identical content: the six seed
        # files converge to the same tree, but a new commit still fires
        # `on: push` and re-triggers the customer's deploy pipeline for no
        # reason. Comparing against base_tree (the branch's tip, read above)
        # rather than any other tree catches exactly the no-op case — the
        # seed content matches what's already at HEAD — without touching the
        # case where stage documents changed and the seed is genuinely new.
        if tree_sha == base_tree:
            return base_sha

        commit_resp = await _send(
            "POST",
            f"{GITHUB_API}/repos/{repo}/git/commits",
            token=token,
            what=f"create_commit for {repo}",
            json={"message": message, "tree": tree_sha, "parents": [base_sha]},
        )
        if commit_resp.is_error:
            raise GithubWriteError(
                f"create_commit failed for {repo}: {commit_resp.status_code} {commit_resp.text}",
                status_code=commit_resp.status_code,
            )
        commit_sha = commit_resp.json()["sha"]

        ref_resp = await _send(
            "PATCH",
            f"{GITHUB_API}/repos/{repo}/git/refs/heads/{branch}",
            token=token,
            what=f"update_ref for {repo}",
            json={"sha": commit_sha, "force": False},
        )
        if ref_resp.is_error:
            if ref_resp.status_code == 422:
                # GitHub answers 422 both for a lost race ("Update is not a
                # fast forward") and for a refusal that no retry will clear —
                # branch protection, a ruleset. Only the message tells them
                # apart, and only the first is a moved branch.
                if _is_not_fast_forward(ref_resp.text):
                    raise GithubBranchMovedError(
                        f"{repo}@{branch} moved during the seed commit", status_code=409
                    )
                raise GithubRefUpdateRejectedError(
                    f"update_ref rejected for {repo}@{branch}: {ref_resp.text}",
                    status_code=422,
                )
            raise GithubWriteError(
                f"update_ref failed for {repo}: {ref_resp.status_code} {ref_resp.text}",
                status_code=ref_resp.status_code,
            )
        return commit_sha

    async def _read_branch_head(self, token: str, repo: str, branch: str) -> tuple[str, str]:
        """(commit sha, tree sha) at the tip of `branch`. Read immediately
        before the write it parents, so a concurrent push is caught by the
        non-forced ref update rather than silently overwritten."""
        ref_resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/git/ref/heads/{branch}",
            token=token,
            what=f"read_ref for {repo}",
        )
        if ref_resp.is_error:
            raise GithubWriteError(
                f"read_ref failed for {repo}: {ref_resp.status_code} {ref_resp.text}",
                status_code=ref_resp.status_code,
            )
        base_sha = ref_resp.json()["object"]["sha"]

        commit_resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/git/commits/{base_sha}",
            token=token,
            what=f"read_commit for {repo}",
        )
        if commit_resp.is_error:
            raise GithubWriteError(
                f"read_commit failed for {repo}: {commit_resp.status_code} {commit_resp.text}",
                status_code=commit_resp.status_code,
            )
        return base_sha, commit_resp.json()["tree"]["sha"]

    async def _create_blob(self, token: str, repo: str, content: str) -> str:
        """base64 rather than utf-8 encoding: a scaffold may carry a binary
        asset or a file with a lone CR, and base64 is the only encoding the
        blobs API accepts for both."""
        resp = await _send(
            "POST",
            f"{GITHUB_API}/repos/{repo}/git/blobs",
            token=token,
            what=f"create_blob for {repo}",
            json={
                "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
                "encoding": "base64",
            },
        )
        if resp.is_error:
            raise GithubWriteError(
                f"create_blob failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        return resp.json()["sha"]

    async def put_actions_secret(self, token: str, repo: str, name: str, value: str) -> None:
        """Repository-level Actions secret. GitHub will not accept a
        plaintext value: it must be a libsodium *sealed box* against the
        repo's Actions public key, base64-encoded. That is why PyNaCl is a
        dependency — the alternative is hand-rolling X25519 + XSalsa20-
        Poly1305, which is not a thing to hand-roll.

        Repo secrets rather than environment secrets, deliberately: an
        environment secret needs the environment created first, which is one
        more call and one more failure mode for no benefit while there is
        exactly one environment (ADR 0021).
        """
        key_id, public_key = await self._actions_public_key(token, repo)
        resp = await _send(
            "PUT",
            f"{GITHUB_API}/repos/{repo}/actions/secrets/{name}",
            token=token,
            what=f"put_actions_secret {name} for {repo}",
            json={"encrypted_value": _seal_secret(public_key, value), "key_id": key_id},
        )
        if resp.is_error:
            # Deliberately does not log `value` or the sealed box.
            raise GithubWriteError(
                f"put_actions_secret failed for {repo}/{name}: {resp.status_code}",
                status_code=resp.status_code,
            )

    async def put_actions_variable(self, token: str, repo: str, name: str, value: str) -> None:
        """Actions *variable* — plaintext, no sealing, and visible in the
        repo's settings. Used for things a workflow needs that are not
        secret (the project id, the web app's origin) precisely so they can
        be corrected later with one API call and no commit."""
        resp = await _send(
            "PATCH",
            f"{GITHUB_API}/repos/{repo}/actions/variables/{name}",
            token=token,
            what=f"update_actions_variable {name} for {repo}",
            json={"name": name, "value": value},
        )
        # PATCH 404s for a variable that does not exist yet; POST creates it.
        # Doing it in this order makes the call idempotent without a prior read.
        if resp.status_code == 404:
            resp = await _send(
                "POST",
                f"{GITHUB_API}/repos/{repo}/actions/variables",
                token=token,
                what=f"create_actions_variable {name} for {repo}",
                json={"name": name, "value": value},
            )
        if resp.is_error:
            raise GithubWriteError(
                f"put_actions_variable failed for {repo}/{name}: "
                f"{resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )

    async def _actions_public_key(self, token: str, repo: str) -> tuple[str, str]:
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/actions/secrets/public-key",
            token=token,
            what=f"actions_public_key for {repo}",
        )
        if resp.is_error:
            raise GithubWriteError(
                f"actions_public_key failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        data = resp.json()
        return data["key_id"], data["key"]

    async def list_repo_hooks(self, token: str, repo: str) -> list[dict]:
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/hooks",
            token=token,
            what=f"list_repo_hooks for {repo}",
        )
        if resp.is_error:
            raise GithubWriteError(
                f"list_repo_hooks failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )
        data = resp.json()
        return data if isinstance(data, list) else []

    async def update_repo_hook(
        self, token: str, repo: str, hook_id: int, events: list[str]
    ) -> None:
        """Widen an existing hook's event list, leaving `config` alone.

        This exists because `create_repo_webhook` swallows 422 ("a hook with
        this config already exists") as success — the behaviour that makes
        repo-creation retries safe is exactly the behaviour that makes
        re-registration a silent no-op. Repos created before ADR 0021 are
        subscribed to `push` and `pull_request` only, and this is the sole
        route by which they learn about deployments.

        Sending only `events` matters: the stored signing secret lives in
        `config`, and a PATCH that included `config` without it would rotate
        the secret out from under `pz_repo_webhooks` and break verification
        for every future delivery.
        """
        resp = await _send(
            "PATCH",
            f"{GITHUB_API}/repos/{repo}/hooks/{hook_id}",
            token=token,
            what=f"update_repo_hook {hook_id} for {repo}",
            json={"events": list(events)},
        )
        if resp.is_error:
            raise GithubWriteError(
                f"update_repo_hook failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )

    async def rotate_repo_hook_secret(
        self,
        token: str,
        repo: str,
        hook_id: int,
        callback_url: str,
        secret: str,
        events: list[str],
    ) -> None:
        """Replace the secret on one existing PromptZone hook.

        This is deliberately a PATCH to the hook selected from
        ``list_repo_hooks``, not a POST to the collection. GitHub permits
        multiple webhooks, and POST can either create a second one or reject
        the request as a duplicate without changing the first hook's secret.
        Supplying the complete config is also intentional: GitHub removes an
        existing secret when a hook update omits it.
        """
        resp = await _send(
            "PATCH",
            f"{GITHUB_API}/repos/{repo}/hooks/{hook_id}",
            token=token,
            what=f"rotate_repo_hook_secret {hook_id} for {repo}",
            json={
                "events": list(events),
                "config": {
                    "url": callback_url,
                    "content_type": "json",
                    "secret": secret,
                    "insecure_ssl": "0",
                },
            },
        )
        if resp.is_error:
            raise GithubWriteError(
                f"rotate_repo_hook_secret failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )

    async def _get_file_sha(self, token: str, repo: str, path: str, branch: str) -> str | None:
        """Blob sha of `path` on `branch`, or None when it doesn't exist.
        A permission failure also returns None — the PUT that follows is the
        authoritative attempt and reports the real error, rather than this
        lookup masking it with a different one. An unreachable GitHub still
        raises, since retrying the same call in the PUT would just fail
        again, one timeout later."""
        resp = await _send(
            "GET",
            f"{GITHUB_API}/repos/{repo}/contents/{path}",
            token=token,
            what=f"lookup sha for {repo}/{path}",
            params={"ref": branch},
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        # A directory comes back as a list; only a file has a sha to reuse.
        return data.get("sha") if isinstance(data, dict) else None


class FakeGithubClient:
    """Deterministic, network-free client for tests. `files` maps
    (repo, path, sha) -> content; unregistered lookups return a distinctive
    placeholder so a storage-posture test has known text to search for."""

    def __init__(self) -> None:
        self.files: dict[tuple[str, str, str], str] = {}
        self.created_repos: list[dict] = []
        self.written_files: dict[tuple[str, str], str] = {}
        self.webhooks: list[dict] = []
        self.verified_tokens: list[tuple[str, str]] = []
        self.fetched_files: list[tuple[str, str, str]] = []
        # ADR 0021. `commits` records whole-tree writes, one entry per commit,
        # so a test can assert "exactly one seed commit" rather than counting
        # files. Secret *values* are recorded because the fake never seals
        # them — asserting on what a repo would receive is the point.
        self.commits: list[dict] = []
        self.secrets: dict[tuple[str, str], str] = {}
        self.variables: dict[tuple[str, str], str] = {}
        self.hooks_events: dict[str, list[str]] = {}
        # Ordered log of externally observable calls. Ordering *is* the
        # contract in create_repository (secrets and the hook must both
        # precede the commit that triggers the first deploy), and only a
        # shared log can assert across otherwise unrelated collections.
        self.call_log: list[str] = []
        # Set-in-test knobs for exercising failure paths without a real API.
        self.fail_on_write_path: str | None = None
        self.fail_on_commit = False
        self.fail_on_webhook = False
        self.webhook_failure_status: int | None = 500
        self.fail_on_hook_rotation = False
        self.fail_on_secret_write: str | None = None
        self.secret_failure_status: int | None = 403
        # Status the simulated write failure reports. Defaults to 500 ("GitHub
        # is unwell"); set 403/404 to exercise the token-scope path.
        self.write_failure_status: int | None = 500
        self.existing_repos: dict[str, dict] = {}
        # Mints ids for fake-created repos, mirroring GitHub's own numeric
        # repository id (plan 0016). A repo seeded directly into
        # existing_repos by a test (to simulate an unrelated repository) must
        # set its own "id" — this counter never overwrites one already there.
        self._next_repo_id: int = 1000
        # Status `get_repo` fails with, for the adopt-on-retry path. None =
        # answer normally (the repo, or None when unknown).
        self.get_repo_failure_status: int | None = None
        self.list_repos_failure_status: int | None = None
        self.list_repos_truncated: bool = False
        # ADR 0023 reconciliation. Keyed (repo, id); an unregistered key is
        # GitHub answering 404, which is exactly the abandoned-deploy case.
        self.deployment_states: dict[tuple[str, str], dict] = {}
        self.workflow_runs: dict[tuple[str, str], dict] = {}
        # ADR 0023 build attribution. Keyed (repo, base, head) and (repo, sha);
        # an unregistered key answers empty, which exercises the fallback.
        self.comparisons: dict[tuple[str, str, str], list[str]] = {}
        self.commit_lists: dict[tuple[str, str], list[str]] = {}
        self.reject_token = False
        self.token_owner_unreachable = False
        self.token_expires_at: str | None = None
        self.token_login = "fake-user"
        # Plan 0027. `trees` is a repository's *pre-existing* content — the
        # files a user's imported repo already had — and deliberately not
        # updated by a seed commit: `create_commit_with_files` below refuses
        # to write any path listed here, which is the no-overwrite guarantee
        # made observable. `branch_heads` is keyed by repo alone (every test
        # repo has one branch that matters); a commit moves it.
        self.trees: dict[str, list[str]] = {}
        self.tree_truncated = False
        self.branch_heads: dict[str, str] = {}
        self.get_tree_failure_status: int | None = None
        # Submodule paths (gitlinks), per repo: listed by `get_tree_entries`
        # as type `commit`, never by `get_tree`.
        self.gitlinks: dict[str, list[str]] = {}
        # With `tree_truncated`, the only paths a *recursive* entries listing
        # returns — what GitHub happened to fit before cutting off. The
        # non-recursive listings still see everything, as GitHub's do.
        self.truncated_listing: dict[str, list[str]] = {}
        # A push that lands between the seed's tree check and its commit: the
        # branch head a commit into this repo finds instead of the one read.
        self.branch_head_on_commit: dict[str, str] = {}
        # Repos whose default branch refuses a direct ref update (protection,
        # a ruleset): a seed commit into one raises GithubRefUpdateRejectedError.
        self.protected_branches: set[str] = set()
        # Directories (by path, "" for the root) whose own non-recursive
        # listing GitHub reports as truncated — a single directory too large
        # to list at all.
        self.truncated_directories: dict[str, set[str]] = {}

    def set_file(self, repo: str, path: str, sha: str, content: str) -> None:
        self.files[(repo, path, sha)] = content

    async def get_deployment(self, token: str, repo: str, deployment_id: str) -> dict | None:
        return self.deployment_states.get((repo, deployment_id))

    async def get_workflow_run(self, token: str, repo: str, run_id: str) -> dict | None:
        return self.workflow_runs.get((repo, run_id))

    async def compare_commits(self, token: str, repo: str, base: str, head: str) -> list[str]:
        # Logged so a freeze test can assert the *absence* of a round trip:
        # a redelivery against an already-frozen build must return the stored
        # set without asking GitHub anything (plan 0024 M2).
        self.call_log.append(f"compare_commits:{repo}:{base}...{head}")
        return list(self.comparisons.get((repo, base, head), []))

    async def list_commits(self, token: str, repo: str, sha: str, limit: int = 100) -> list[str]:
        self.call_log.append(f"list_commits:{repo}:{sha}")
        return list(self.commit_lists.get((repo, sha), []))[:limit]

    async def verify_token(self, token: str, owner: str) -> TokenIdentity:
        self.verified_tokens.append((token, owner))
        if self.reject_token:
            raise GithubAuthError("token_rejected")
        return TokenIdentity(
            login=self.token_login,
            expires_at=self.token_expires_at,
            can_access_owner=not self.token_owner_unreachable,
            owner_type="User" if owner == self.token_login else "Organization",
        )

    async def create_repo_webhook(
        self, token: str, repo: str, callback_url: str, secret: str
    ) -> bool:
        self.call_log.append(f"webhook:{repo}")
        if self.fail_on_webhook:
            raise GithubWriteError(
                f"fake webhook failure for {repo}", status_code=self.webhook_failure_status
            )
        # GitHub rejects a duplicate hook registration and leaves the
        # original hook (including its secret) untouched. Keeping one hook
        # per repository lets retry tests observe the same behavior rather
        # than silently inventing a second remote secret.
        if any(hook["repo"] == repo and hook["url"] == callback_url for hook in self.webhooks):
            return False
        self.webhooks.append(
            {
                "repo": repo,
                "url": callback_url,
                "secret": secret,
                "events": list(WEBHOOK_EVENTS),
            }
        )
        self.hooks_events.setdefault(repo, list(WEBHOOK_EVENTS))
        return True

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str:
        self.fetched_files.append((repo, path, sha))
        return self.files.get((repo, path, sha), f"fake content for {repo}/{path}@{sha}")

    async def create_org_repo(
        self,
        token: str,
        org: str,
        name: str,
        description: str,
        private: bool,
        owner_type: str = "Organization",
    ) -> dict:
        full_name = f"{org}/{name}"
        if full_name in self.existing_repos:
            raise RepoAlreadyExistsError(f"repo {full_name} already exists")
        self.call_log.append(f"create_repo:{full_name}")
        self._next_repo_id += 1
        record = {
            "id": self._next_repo_id,
            "full_name": full_name,
            "html_url": f"https://github.com/{full_name}",
            "default_branch": "main",
            "description": description,
        }
        self.created_repos.append(record)
        self.existing_repos[full_name] = record
        return record

    async def get_repo(self, token: str, repo: str) -> dict | None:
        self.call_log.append(f"get_repo:{repo}")
        if self.get_repo_failure_status is not None:
            raise GithubWriteError(
                f"fake get_repo failure for {repo}",
                status_code=self.get_repo_failure_status,
            )
        found = self.existing_repos.get(repo)
        return _repo_row(found) if found is not None else None

    async def get_branch_head(self, token: str, repo: str, branch: str) -> str:
        self.call_log.append(f"branch_head:{repo}")
        if self.get_tree_failure_status is not None:
            raise GithubWriteError(
                f"fake get_branch_head failure for {repo}",
                status_code=self.get_tree_failure_status,
            )
        return self.branch_heads.get(repo, "fake-head-0")

    async def get_tree(self, token: str, repo: str, sha: str) -> tuple[list[str], bool]:
        self.call_log.append(f"tree:{repo}")
        if self.get_tree_failure_status is not None:
            raise GithubWriteError(
                f"fake get_tree failure for {repo}", status_code=self.get_tree_failure_status
            )
        return list(self.trees.get(repo, [])), self.tree_truncated

    async def get_tree_entries(
        self, token: str, repo: str, sha: str, *, recursive: bool = True
    ) -> tuple[list[dict], bool]:
        self.call_log.append(f"tree:{repo}")
        if self.get_tree_failure_status is not None:
            raise GithubWriteError(
                f"fake get_tree failure for {repo}", status_code=self.get_tree_failure_status
            )
        types: dict[str, str] = {}
        listed = (("blob", self.trees.get(repo, [])), ("commit", self.gitlinks.get(repo, [])))
        for kind, paths in listed:
            for path in paths:
                parts = path.split("/")
                for depth in range(1, len(parts)):
                    types.setdefault("/".join(parts[:depth]), "tree")
                types[path] = kind
        entries = [
            {"path": path, "type": kind, "sha": f"fake-tree:{path}" if kind == "tree" else None}
            for path, kind in sorted(types.items())
        ]
        if recursive:
            if self.tree_truncated:
                visible = set(self.truncated_listing.get(repo, []))
                return [e for e in entries if e["path"] in visible], True
            return entries, False
        directory = sha[len("fake-tree:") :] if sha.startswith("fake-tree:") else ""
        return [
            {**e, "path": posixpath.basename(e["path"])}
            for e in entries
            if posixpath.dirname(e["path"]) == directory
        ], directory in self.truncated_directories.get(repo, set())

    async def list_repos(
        self,
        token: str,
        owner: str,
        owner_type: str = "Organization",
        max_pages: int = 5,
    ) -> tuple[list[dict], bool]:
        """Answers from `existing_repos`, so one fixture serves both the picker
        and the adopt path a test drives afterwards."""
        self.call_log.append(f"list_repos:{owner}")
        if self.list_repos_failure_status is not None:
            raise GithubWriteError(
                f"fake list_repos failure for {owner}",
                status_code=self.list_repos_failure_status,
            )
        rows = [
            _repo_row(record)
            for full_name, record in self.existing_repos.items()
            if full_name.split("/")[0].lower() == owner.lower()
        ]
        return rows, self.list_repos_truncated

    async def put_file_content(
        self,
        token: str,
        repo: str,
        path: str,
        content: str,
        message: str,
        branch: str,
        sha: str | None = None,
    ) -> str:
        if self.fail_on_write_path is not None and path == self.fail_on_write_path:
            raise GithubWriteError(
                f"fake write failure for {repo}/{path}",
                status_code=self.write_failure_status,
            )
        self.call_log.append(f"put:{path}")
        self.written_files[(repo, path)] = content
        # Also lands in `files` (keyed by a synthetic sha) so a follow-up
        # fetch_file_content sees the just-written content.
        fake_sha = f"fake-sha-{len(self.written_files)}"
        self.files[(repo, path, fake_sha)] = content
        return fake_sha

    async def create_commit_with_files(
        self,
        token: str,
        repo: str,
        branch: str,
        files: list[SeedFile],
        message: str,
        expected_base_sha: str | None = None,
    ) -> str:
        if repo in self.branch_head_on_commit:
            self.branch_heads[repo] = self.branch_head_on_commit.pop(repo)
        if expected_base_sha is not None and (
            self.branch_heads.get(repo, "fake-head-0") != expected_base_sha
        ):
            raise GithubBranchMovedError(f"fake branch moved for {repo}", status_code=409)
        if repo in self.protected_branches:
            raise GithubRefUpdateRejectedError(
                f"fake protected branch {branch} in {repo}", status_code=422
            )
        if self.fail_on_commit:
            raise GithubWriteError(
                f"fake commit failure for {repo}", status_code=self.write_failure_status
            )
        if self.fail_on_write_path is not None and any(
            f.path == self.fail_on_write_path for f in files
        ):
            raise GithubWriteError(
                f"fake write failure for {repo}/{self.fail_on_write_path}",
                status_code=self.write_failure_status,
            )
        # The real client would silently replace these blobs in the new tree;
        # here it is a test failure instead, so a seed that overwrites a file
        # the imported repository already had cannot pass unnoticed (plan
        # 0027 M4).
        # Case-insensitively, and through a path prefix: a file (or a
        # submodule) at `docs` is just as much in the way of `docs/x.md`.
        def prefixes(path: str) -> set[str]:
            return {path.rsplit("/", depth)[0] for depth in range(1, path.count("/") + 1)}

        existing = {p.lower() for p in (*self.trees.get(repo, []), *self.gitlinks.get(repo, []))}
        existing_dirs = set().union(*(prefixes(p) for p in existing))
        overwritten = sorted(
            f.path
            for f in files
            if f.path.lower() in existing | existing_dirs or prefixes(f.path.lower()) & existing
        )
        assert not overwritten, f"seed commit overwrites existing files in {repo}: {overwritten}"
        self.call_log.append(f"commit:{repo}")
        commit_sha = f"fake-commit-{len(self.commits) + 1}"
        self.branch_heads[repo] = commit_sha
        self.commits.append(
            {
                "repo": repo,
                "branch": branch,
                "message": message,
                "sha": commit_sha,
                "paths": [f.path for f in files],
            }
        )
        # Mirror into the per-file collections so existing assertions about
        # seeded content keep working across the switch to tree writes.
        for seed_file in files:
            self.written_files[(repo, seed_file.path)] = seed_file.content
            self.files[(repo, seed_file.path, commit_sha)] = seed_file.content
        return commit_sha

    async def put_actions_secret(self, token: str, repo: str, name: str, value: str) -> None:
        if self.fail_on_secret_write is not None and name == self.fail_on_secret_write:
            raise GithubWriteError(
                f"fake secret failure for {repo}/{name}",
                status_code=self.secret_failure_status,
            )
        self.call_log.append(f"secret:{name}")
        self.secrets[(repo, name)] = value

    async def put_actions_variable(self, token: str, repo: str, name: str, value: str) -> None:
        self.call_log.append(f"variable:{name}")
        self.variables[(repo, name)] = value

    async def list_repo_hooks(self, token: str, repo: str) -> list[dict]:
        hooks = [hook for hook in self.webhooks if hook["repo"] == repo]
        return [
            {
                "id": index,
                "events": list(hook.get("events", self.hooks_events.get(repo, []))),
                "config": {"url": hook["url"]},
            }
            for index, hook in enumerate(hooks, start=1)
        ]

    async def update_repo_hook(
        self, token: str, repo: str, hook_id: int, events: list[str]
    ) -> None:
        self.call_log.append(f"hook_update:{repo}")
        hooks = [hook for hook in self.webhooks if hook["repo"] == repo]
        if hook_id < 1 or hook_id > len(hooks):
            raise GithubWriteError(f"fake hook {hook_id} missing for {repo}", status_code=404)
        hooks[hook_id - 1]["events"] = list(events)
        self.hooks_events[repo] = list(events)

    async def rotate_repo_hook_secret(
        self,
        token: str,
        repo: str,
        hook_id: int,
        callback_url: str,
        secret: str,
        events: list[str],
    ) -> None:
        self.call_log.append(f"hook_rotate:{repo}")
        if self.fail_on_hook_rotation:
            raise GithubWriteError(f"fake hook rotation failure for {repo}", status_code=500)
        hooks = [hook for hook in self.webhooks if hook["repo"] == repo]
        if hook_id < 1 or hook_id > len(hooks):
            raise GithubWriteError(f"fake hook {hook_id} missing for {repo}", status_code=404)
        hook = hooks[hook_id - 1]
        if hook["url"] != callback_url:
            raise GithubWriteError(f"fake hook {hook_id} URL changed for {repo}", status_code=409)
        hook["secret"] = secret
        hook["events"] = list(events)
        self.hooks_events[repo] = list(events)
