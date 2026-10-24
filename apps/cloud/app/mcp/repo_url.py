"""Repository URL matching for the hosted MCP server, and resolving a tool's
`project_id` / `repo_url` arguments to one of the caller's projects.

`normalize_repo_url`, `same_repo` and `remotes_match` are a port of
packages/cloud-client/src/repoUrl.ts (`normalizeRepoUrl`, `sameRepo`,
`remotesMatch`), held to the same answers by the shared case table
docs/contracts/repo-url-cases.json, which both test suites read. The rule is
normative in docs/contracts/repo-url-matching.md. The TS side parses with the
WHATWG `URL`; the parts of that parser the comparison can observe (host
validity, default ports, dot segments, path percent-encoding) are reproduced
here so the two agree on every case.

`resolve_project` is how every planning tool finds its project: `project_id`
wins, else the URL is matched against every project in the caller's
workspaces with `projectsMatchingRemotes`' precedence. Either way the result
goes through `require_project`, so a tool never reaches a project its caller
is not a member of."""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from mcp.server.mcpserver.exceptions import ToolError

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User
from app.models.schemas import Project

RemoteMatch = Literal["exact", "alias", "none"]

_SSH_SHORTHAND_RE = re.compile(r"[A-Za-z0-9_.-]+@([^:/]+):(.+)")
_SCHEME_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
# WHATWG "forbidden host code points" (plus whitespace): a host containing one
# makes `new URL` throw, which normalizeRepoUrl reports as null.
_FORBIDDEN_HOST = re.compile(r"[\x00-\x20#%/:<>?@\[\\\]^|\x7f]")
_DEFAULT_PORTS = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21}
_SPECIAL = {"http", "https", "ws", "wss", "ftp", "file"}
# The WHATWG path percent-encode set, less what the comparison never sees.
_PATH_ENCODE = set('"<>`{} ')


def _encode_path(path: str) -> str:
    out: list[str] = []
    for ch in path:
        code = ord(ch)
        if code < 0x20 or code >= 0x7F or ch in _PATH_ENCODE:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8"))
        else:
            out.append(ch)
    return "".join(out)


def _remove_dot_segments(path: str) -> str:
    segments = path.split("/")[1:] if path.startswith("/") else path.split("/")
    out: list[str] = []
    for i, seg in enumerate(segments):
        last = i == len(segments) - 1
        lowered = seg.lower()
        if lowered in ("..", ".%2e", "%2e.", "%2e%2e"):
            if out:
                out.pop()
            if last:
                out.append("")
        elif lowered in (".", "%2e"):
            if last:
                out.append("")
        else:
            out.append(seg)
    return "/" + "/".join(out)


def _parse(value: str) -> tuple[str, str, str, int | None] | None:
    """(scheme, hostname, pathname, explicit port) the way `new URL` reads
    `value`, or None where it would throw."""
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    if host and "[" in parts.netloc:
        host = f"[{host}]"  # an IPv6 literal keeps its brackets, as in `URL.hostname`
    elif not host or _FORBIDDEN_HOST.search(host):
        return None
    if not host.isascii():
        if scheme not in _SPECIAL:
            return None
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            return None
    path = parts.path
    if scheme in _SPECIAL:
        path = path.replace("\\", "/") or "/"
    if path:
        path = _remove_dot_segments(path)
    if port is not None and _DEFAULT_PORTS.get(scheme) == port:
        port = None
    return scheme, host, _encode_path(path), port


def normalize_repo_url(raw: str | None) -> str | None:
    """Reduce a remote to a comparable `host/path` key; None for anything
    unrecognised, which a caller treats as "no match", never "matches
    everything"."""
    if not raw:
        return None
    value = raw.strip()
    if not value:
        return None

    ssh = _SSH_SHORTHAND_RE.fullmatch(value)
    if ssh:
        value = f"{ssh.group(1)}/{ssh.group(2)}"
    else:
        with_scheme = value if _SCHEME_RE.match(value) else f"https://{value}"
        parsed = _parse(with_scheme)
        if parsed is None:
            return None
        _, host, path, _ = parsed
        value = f"{host}{path}"

    value = value.lower()
    value = re.sub(r"\.git\Z", "", value)
    value = re.sub(r"/+\Z", "", value)
    value = re.sub(r"/{2,}", "/", value)
    return value or None


def same_repo(a: str | None, b: str | None) -> bool:
    left = normalize_repo_url(a)
    right = normalize_repo_url(b)
    return left is not None and left == right


def _alias_base_host(host: str) -> str:
    """The host an SSH-config alias stands for (`github.com-work` ->
    `github.com`), or the host itself. Only a hyphen in the LAST label is an
    alias suffix; an IDN TLD (`xn--...`) is left alone."""
    last_dot = host.rfind(".")
    if last_dot < 0:
        return host
    label = host[last_dot + 1 :]
    if label.startswith("xn--"):
        return host
    dash = label.find("-")
    if dash <= 0 or dash == len(label) - 1:
        return host
    return host[: last_dot + 1 + dash]


def _split_key(key: str) -> tuple[str, str]:
    host, _, path = key.partition("/")
    return host, path


def _has_explicit_port(raw: str) -> bool:
    value = raw.strip()
    if not _SCHEME_RE.match(value):
        return False
    parsed = _parse(value)
    return parsed is not None and parsed[3] is not None


def remotes_match(remote: str | None, repo_url: str | None) -> RemoteMatch:
    """`exact` when both name one repository on one host; `alias` when the
    hosts differ only by a `-<suffix>` on the same base host, the paths are
    identical and neither side names a port; else `none`."""
    left = normalize_repo_url(remote)
    right = normalize_repo_url(repo_url)
    if left is None or right is None:
        return "none"
    if left == right:
        return "exact"
    a_host, a_path = _split_key(left)
    b_host, b_path = _split_key(right)
    if not a_path or a_path != b_path:
        return "none"
    if _has_explicit_port(remote or "") or _has_explicit_port(repo_url or ""):
        return "none"
    return "alias" if _alias_base_host(a_host) == _alias_base_host(b_host) else "none"


# --------------------------------------------------------------------------- #
# Resolving a tool's project arguments
# --------------------------------------------------------------------------- #

_SENTENCES = {
    "project_not_found": "no project has that id; pass a project_id from your workspaces.",
    "not_a_member": "you are not a member of this project's workspace.",
}


def _guarded(repo: Repository, project_id: str, user: User) -> Project:
    try:
        return require_project(repo, project_id, user)
    except HTTPException as err:
        detail = str(err.detail)
        raise ToolError(f"{detail}: {_SENTENCES.get(detail, 'the request was refused.')}") from err


def _projects_in_my_workspaces(repo: Repository, user: User) -> list[Project]:
    """Every project the caller can see: their workspaces (the roster's
    `list_workspaces`) and each one's projects (GET /workspaces/{id}/projects)."""
    return [
        project
        for workspace in repo.list_workspaces(user.id)
        for project in repo.list_projects_by_workspace(workspace.id)
    ]


def resolve_project(
    repo: Repository, user: User, *, project_id: str | None, repo_url: str | None
) -> Project:
    if project_id and project_id.strip():
        return _guarded(repo, project_id.strip(), user)
    if not repo_url or not repo_url.strip():
        raise ToolError("project_required: pass project_id or repo_url")
    url = repo_url.strip()

    exact: list[Project] = []
    alias: list[Project] = []
    for project in _projects_in_my_workspaces(repo, user):
        if not project.repo_url:
            continue
        match = remotes_match(url, project.repo_url)
        if match == "exact":
            exact.append(project)
        elif match == "alias":
            alias.append(project)
    # Exact matches win and all count; an alias is a weaker claim, consulted
    # only when nothing matched exactly. More than one candidate either way
    # links none of them (projectsMatchingRemotes in repoUrl.ts).
    candidates = exact or alias
    if not candidates:
        raise ToolError(
            f"no_project_for_repo: no project in your workspaces uses {url}; pass project_id"
        )
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates)
        raise ToolError(f"ambiguous_repo: {names} share this repository; pass project_id")
    return _guarded(repo, candidates[0].id, user)
