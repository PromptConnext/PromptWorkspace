"""GitHub App integration (M11): PR + push webhook parsing, installation-
token minting, and fetch-on-demand file content.

Doesn't fit app/integrations/tracker.py's TrackerAdapter protocol — that's
shaped around pmo-field task mirroring (InboundUpdate.status/assignee/
sprint). GitHub's events (PR opened/merged, push) drive indexing, not field
updates, so this module and app/api/github.py stand on their own rather than
distorting the Jira/ClickUp registry to fit.

One GitHub App is shared across all workspaces (Settings.github_app_id /
github_app_private_key / github_webhook_secret — server env, never in
Postgres, same rule as jira_api_token). No installation access token is ever
persisted: mint_installation_token() produces a short-lived one (GitHub
caps these at ~1h) from the App's private key, used once per request and
discarded. This is a stricter posture than Jira's static API token — GitHub
gives us the option, so we take it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import jwt

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


def app_jwt(app_id: str, private_key: str) -> str:
    """Short-lived App-level JWT (RS256), used only to mint an installation
    access token — never used for any other API call."""
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 540, "iss": app_id}
    return jwt.encode(payload, private_key, algorithm="RS256")


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
    ignorant of the HTTP client this module happens to use."""


class RepoAlreadyExistsError(GithubWriteError):
    """`create_org_repo` got a 422 "name already exists" — the caller
    decides whether to adopt the existing repo (retry after a partial
    failure) or surface `repo_name_taken`."""


class GithubClient(Protocol):
    async def mint_installation_token(
        self, app_id: str, private_key: str, installation_id: str
    ) -> str: ...

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


class HttpGithubClient:
    async def mint_installation_token(
        self, app_id: str, private_key: str, installation_id: str
    ) -> str:
        token = app_jwt(app_id, private_key)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
            resp.raise_for_status()
            return resp.json()["token"]

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}/contents/{path}",
                params={"ref": sha},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            return base64.b64decode(data["content"]).decode("utf-8", errors="replace")

    async def create_org_repo(
        self, token: str, org: str, name: str, description: str, private: bool
    ) -> dict:
        """`auto_init: true` is required — the contents API (used by
        `put_file_content`) cannot write into a zero-commit repo without
        blob/tree plumbing, so GitHub must create the initial commit."""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{GITHUB_API}/orgs/{org}/repos",
                json={
                    "name": name,
                    "description": description,
                    "private": private,
                    "auto_init": True,
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
            if resp.status_code == 422:
                raise RepoAlreadyExistsError(f"repo {org}/{name} already exists")
            if resp.is_error:
                raise GithubWriteError(f"create_org_repo failed: {resp.status_code} {resp.text}")
            data = resp.json()
            return {
                "full_name": data["full_name"],
                "html_url": data["html_url"],
                "default_branch": data.get("default_branch", "main"),
            }

    async def get_repo(self, token: str, repo: str) -> dict | None:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{repo}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
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
        body: dict = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch": branch,
        }
        if sha is not None:
            body["sha"] = sha
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.put(
                f"{GITHUB_API}/repos/{repo}/contents/{path}",
                json=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                },
            )
            if resp.is_error:
                raise GithubWriteError(
                    f"put_file_content failed for {repo}/{path}: {resp.status_code} {resp.text}"
                )
            data = resp.json()
            return data["content"]["sha"]


class FakeGithubClient:
    """Deterministic, network-free client for tests. `files` maps
    (repo, path, sha) -> content; unregistered lookups return a distinctive
    placeholder so a storage-posture test has known text to search for."""

    def __init__(self) -> None:
        self.files: dict[tuple[str, str, str], str] = {}
        self.minted_tokens = 0
        self.created_repos: list[dict] = []
        self.written_files: dict[tuple[str, str], str] = {}
        # Set-in-test knobs for exercising failure paths without a real API.
        self.fail_on_write_path: str | None = None
        self.existing_repos: dict[str, dict] = {}

    def set_file(self, repo: str, path: str, sha: str, content: str) -> None:
        self.files[(repo, path, sha)] = content

    async def mint_installation_token(
        self, app_id: str, private_key: str, installation_id: str
    ) -> str:
        self.minted_tokens += 1
        return f"fake-installation-token-{installation_id}"

    async def fetch_file_content(self, token: str, repo: str, path: str, sha: str) -> str:
        return self.files.get((repo, path, sha), f"fake content for {repo}/{path}@{sha}")

    async def create_org_repo(
        self, token: str, org: str, name: str, description: str, private: bool
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
            raise GithubWriteError(f"fake write failure for {repo}/{path}")
        self.written_files[(repo, path)] = content
        # Also lands in `files` (keyed by a synthetic sha) so a follow-up
        # fetch_file_content sees the just-written content.
        fake_sha = f"fake-sha-{len(self.written_files)}"
        self.files[(repo, path, fake_sha)] = content
        return fake_sha
