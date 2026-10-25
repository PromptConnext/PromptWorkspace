"""Repository URL matching for the hosted MCP server, and how a tool's
`project_id`/`repo_url` arguments resolve to one of the caller's projects.

`app/mcp/repo_url.py` is a port of packages/cloud-client/src/repoUrl.ts; both
suites read the same case table, docs/contracts/repo-url-cases.json, so the
two can never disagree about one clone. Prose: docs/contracts/repo-url-matching.md."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from app.db.repository import InMemoryRepository
from app.dependencies import User
from app.mcp.repo_url import normalize_repo_url, remotes_match, resolve_project, same_repo
from app.models.schemas import Role

_CASES_PATH = Path(__file__).resolve().parents[3] / "docs" / "contracts" / "repo-url-cases.json"
_CASES = json.loads(_CASES_PATH.read_text(encoding="utf-8"))


def test_the_case_table_is_not_empty():
    assert {c["expect"] for c in _CASES} == {"exact", "alias", "none"}


@pytest.mark.parametrize("case", _CASES, ids=lambda c: f"{c['a']!r}~{c['b']!r}")
def test_shared_cases(case):
    assert remotes_match(case["a"], case["b"]) == case["expect"]
    assert same_repo(case["a"], case["b"]) is (case["expect"] == "exact")


def test_normalize_repo_url_shapes():
    assert normalize_repo_url("git@GitHub.com:Acme/App.git") == "github.com/acme/app"
    assert normalize_repo_url("https://t:x@github.com/acme/app/") == "github.com/acme/app"
    assert normalize_repo_url("ssh://git@host.example:2222/a/b") == "host.example/a/b"
    assert normalize_repo_url("") is None
    assert normalize_repo_url(None) is None
    assert normalize_repo_url("https://") is None


# --------------------------------------------------------------------------- #
# resolve_project
# --------------------------------------------------------------------------- #

ALICE = User(id="alice", email="alice@x.com")
BOB = User(id="bob", email="bob@x.com")
EVE = User(id="eve", email="eve@x.com")


@pytest.fixture
def repo():
    r = InMemoryRepository()
    ws = r.create_workspace("Acme", "alice", "alice@x.com")
    r.add_member(ws.id, "bob", Role.member, email="bob@x.com")
    other = r.create_workspace("Elsewhere", "eve", "eve@x.com")
    r.create_project(ws.id, "alice", "Alpha", repo_url="https://github.com/acme/alpha")
    r.create_project(ws.id, "alice", "Beta", repo_url="https://github.com/acme/beta.git")
    r.create_project(ws.id, "alice", "Beta fork", repo_url="git@github.com:acme/beta.git")
    r.create_project(ws.id, "alice", "Scratch")
    # Not bob's: a project in a workspace he is not a member of.
    r.create_project(other.id, "eve", "Hidden", repo_url="https://github.com/acme/hidden")
    return r


def _by_name(repo, name):
    return next(p for ws in repo.list_workspaces("alice") + repo.list_workspaces("eve")
                for p in repo.list_projects_by_workspace(ws.id) if p.name == name)  # fmt: skip


def test_project_id_wins_over_repo_url(repo):
    alpha = _by_name(repo, "Alpha")
    got = resolve_project(
        repo, BOB, project_id=alpha.id, repo_url="https://github.com/acme/beta"
    )
    assert got.id == alpha.id


def test_project_id_outside_the_callers_workspaces_is_refused(repo):
    hidden = _by_name(repo, "Hidden")
    with pytest.raises(ToolError, match="^not_a_member: "):
        resolve_project(repo, BOB, project_id=hidden.id, repo_url=None)
    with pytest.raises(ToolError, match="^project_not_found: "):
        resolve_project(repo, BOB, project_id="nope", repo_url=None)


def test_repo_url_resolves_an_exact_match(repo):
    got = resolve_project(repo, BOB, project_id=None, repo_url="git@github.com:Acme/alpha.git")
    assert got.name == "Alpha"


def test_repo_url_resolves_a_single_alias(repo):
    got = resolve_project(repo, BOB, project_id=None, repo_url="git@github.com-work:acme/alpha")
    assert got.name == "Alpha"


def test_repo_url_matching_two_projects_is_ambiguous(repo):
    with pytest.raises(ToolError) as err:
        resolve_project(repo, BOB, project_id=None, repo_url="https://github.com/acme/beta")
    assert str(err.value) == (
        "ambiguous_repo: Beta, Beta fork share this repository; pass project_id"
    )


def test_an_alias_matching_two_projects_links_neither(repo):
    with pytest.raises(ToolError, match="^ambiguous_repo: Beta, Beta fork "):
        resolve_project(repo, BOB, project_id=None, repo_url="git@github.com-work:acme/beta")


def test_repo_url_with_no_project_and_never_another_workspaces(repo):
    for url in ("https://github.com/acme/nothing", "https://github.com/acme/hidden"):
        with pytest.raises(ToolError) as err:
            resolve_project(repo, BOB, project_id=None, repo_url=url)
        assert str(err.value) == (
            f"no_project_for_repo: no project in your workspaces uses {url}; pass project_id"
        )


def test_an_unparseable_repo_url_matches_nothing(repo):
    with pytest.raises(ToolError, match="^no_project_for_repo: "):
        resolve_project(repo, BOB, project_id=None, repo_url="https://")


def test_neither_argument_is_refused(repo):
    with pytest.raises(ToolError) as err:
        resolve_project(repo, BOB, project_id=None, repo_url=None)
    assert str(err.value) == "project_required: pass project_id or repo_url"
    with pytest.raises(ToolError, match="^project_required: "):
        resolve_project(repo, EVE, project_id="", repo_url="  ")
