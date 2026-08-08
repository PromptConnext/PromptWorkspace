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
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field
from typing import Protocol

import httpx

GITHUB_API = "https://api.github.com"

# Same convention apps/engine/src/routes/projects.ts's syncTasksFromGit uses
# to mark tasks done from commit subjects (ADR 0007/0009) — kept identical
# so a PR title/body and a commit subject resolve to the same task.
_TASK_REF_RE = re.compile(r"\bT\d{3}\b")


def extract_task_refs(text: str) -> set[str]:
    return set(_TASK_REF_RE.findall(text or ""))


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
class PushEvent:
    after_sha: str
    changed_paths: list[str] = field(default_factory=list)
    removed_paths: list[str] = field(default_factory=list)


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
    for commit in payload.get("commits") or []:
        for path in commit.get("added") or []:
            path_action[path] = "changed"
        for path in commit.get("modified") or []:
            path_action[path] = "changed"
        for path in commit.get("removed") or []:
            path_action[path] = "removed"

    changed = [p for p, a in path_action.items() if a == "changed"]
    removed = [p for p, a in path_action.items() if a == "removed"]
    return PushEvent(after_sha=after_sha, changed_paths=changed, removed_paths=removed)


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


class RepoAlreadyExistsError(GithubWriteError):
    """`create_org_repo` got a 422 "name already exists" — the caller
    decides whether to adopt the existing repo (retry after a partial
    failure) or surface `repo_name_taken`."""


class GithubClient(Protocol):
    async def verify_token(self, token: str, owner: str) -> TokenIdentity: ...

    async def create_repo_webhook(
        self, token: str, repo: str, callback_url: str, secret: str
    ) -> None: ...

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str: ...

    async def create_org_repo(
        self, token: str, org: str, name: str, description: str, private: bool
    ) -> dict: ...

    async def get_repo(self, token: str, repo: str) -> dict | None: ...

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
    ) -> None:
        resp = await _send(
            "POST",
            f"{GITHUB_API}/repos/{repo}/hooks",
            token=token,
            what=f"create_repo_webhook for {repo}",
            json={
                "name": "web",
                "active": True,
                "events": ["push", "pull_request"],
                "config": {
                    "url": callback_url,
                    "content_type": "json",
                    "secret": secret,
                    "insecure_ssl": "0",
                },
            },
        )
        # 422 means a hook with this config already exists — a retry after
        # a partial failure, not an error worth failing repo creation over.
        if resp.status_code == 422:
            return
        if resp.is_error:
            raise GithubWriteError(
                f"create_repo_webhook failed for {repo}: {resp.status_code} {resp.text}",
                status_code=resp.status_code,
            )

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
        data = resp.json()
        return {
            "full_name": data["full_name"],
            "html_url": data["html_url"],
            "default_branch": data.get("default_branch", "main"),
        }

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
        data = resp.json()
        return {
            "full_name": data["full_name"],
            "html_url": data["html_url"],
            "default_branch": data.get("default_branch", "main"),
        }

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
        # Set-in-test knobs for exercising failure paths without a real API.
        self.fail_on_write_path: str | None = None
        # Status the simulated write failure reports. Defaults to 500 ("GitHub
        # is unwell"); set 403/404 to exercise the token-scope path.
        self.write_failure_status: int | None = 500
        self.existing_repos: dict[str, dict] = {}
        # Status `get_repo` fails with, for the adopt-on-retry path. None =
        # answer normally (the repo, or None when unknown).
        self.get_repo_failure_status: int | None = None
        self.reject_token = False
        self.token_owner_unreachable = False
        self.token_expires_at: str | None = None
        self.token_login = "fake-user"

    def set_file(self, repo: str, path: str, sha: str, content: str) -> None:
        self.files[(repo, path, sha)] = content

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
    ) -> None:
        self.webhooks.append({"repo": repo, "url": callback_url, "secret": secret})

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
        record = {
            "full_name": full_name,
            "html_url": f"https://github.com/{full_name}",
            "default_branch": "main",
        }
        self.created_repos.append(record)
        self.existing_repos[full_name] = record
        return record

    async def get_repo(self, token: str, repo: str) -> dict | None:
        if self.get_repo_failure_status is not None:
            raise GithubWriteError(
                f"fake get_repo failure for {repo}",
                status_code=self.get_repo_failure_status,
            )
        return self.existing_repos.get(repo)

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
        self.written_files[(repo, path)] = content
        # Also lands in `files` (keyed by a synthetic sha) so a follow-up
        # fetch_file_content sees the just-written content.
        fake_sha = f"fake-sha-{len(self.written_files)}"
        self.files[(repo, path, fake_sha)] = content
        return fake_sha
