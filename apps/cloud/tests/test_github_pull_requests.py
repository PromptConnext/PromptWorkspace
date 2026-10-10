"""Branch and pull-request calls against a simulated GitHub REST API.

Same pattern as `test_github_contents_upsert.py`: no asyncio plugin, so each
test drives the coroutine through `asyncio.run`, with httpx.MockTransport
standing in for api.github.com. The handler records every request so a test
can assert on the method, path and JSON body that would reach GitHub.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.integrations.github import (
    GithubBranchMovedError,
    GithubCompareTooLargeError,
    GithubPullRequestExistsError,
    GithubWriteError,
    HttpGithubClient,
)

REPO = "acme/make-story-time"


@pytest.fixture
def github(monkeypatch):
    """Routes every httpx.AsyncClient at a handler the test configures.
    Returns (responses, recorded) where `responses` maps (method, path) to an
    httpx.Response and `recorded` lists each request as a dict."""
    # A value is a response, or a callable taking the request (for paging).
    responses: dict[tuple[str, str], object] = {}
    recorded: list[dict] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        recorded.append(
            {
                "method": request.method,
                "path": request.url.path,
                "params": dict(request.url.params),
                "json": json.loads(request.content) if request.content else None,
            }
        )
        found = responses.get((request.method, request.url.path))
        if callable(found):
            return found(request)
        return found or httpx.Response(404, json={"message": "Not Found"})

    def factory(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return responses, recorded


def test_create_branch_posts_a_ref(github):
    responses, recorded = github
    responses[("POST", f"/repos/{REPO}/git/refs")] = httpx.Response(
        201, json={"ref": "refs/heads/pw/sync-docs-x", "object": {"sha": "abc123"}}
    )

    asyncio.run(HttpGithubClient().create_branch("tok", REPO, "pw/sync-docs-x", "abc123"))

    assert recorded == [
        {
            "method": "POST",
            "path": f"/repos/{REPO}/git/refs",
            "params": {},
            "json": {"ref": "refs/heads/pw/sync-docs-x", "sha": "abc123"},
        }
    ]


def test_create_branch_that_exists_raises_branch_moved(github):
    responses, _ = github
    responses[("POST", f"/repos/{REPO}/git/refs")] = httpx.Response(
        422, json={"message": "Reference already exists"}
    )

    with pytest.raises(GithubBranchMovedError):
        asyncio.run(HttpGithubClient().create_branch("tok", REPO, "pw/sync-docs-x", "abc123"))


def test_create_branch_other_failure_carries_the_status(github):
    responses, _ = github
    responses[("POST", f"/repos/{REPO}/git/refs")] = httpx.Response(
        403, json={"message": "Resource not accessible by personal access token"}
    )

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(HttpGithubClient().create_branch("tok", REPO, "pw/sync-docs-x", "abc123"))
    assert not isinstance(excinfo.value, GithubBranchMovedError)
    assert excinfo.value.status_code == 403


def _pull(
    number: int,
    ref: str,
    head_repo: str = REPO,
    base: str = "main",
    login: str = "pw-bot",
) -> dict:
    return {
        "number": number,
        "html_url": f"https://github.com/{REPO}/pull/{number}",
        "head": {"ref": ref, "sha": f"sha-{number}", "repo": {"full_name": head_repo}},
        "base": {"ref": base},
        "user": {"login": login},
    }


def test_find_open_pull_request_matches_the_head_prefix(github):
    responses, recorded = github
    responses[("GET", f"/repos/{REPO}/pulls")] = httpx.Response(
        200, json=[_pull(3, "feature/login"), _pull(7, "pw/sync-docs-20261010120000")]
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found == {
        "number": 7,
        "html_url": f"https://github.com/{REPO}/pull/7",
        "head": "pw/sync-docs-20261010120000",
        "author": "pw-bot",
    }
    # A match on the first page stops the paging.
    assert [r["params"] for r in recorded] == [{"state": "open", "per_page": "100", "page": "1"}]


def test_find_open_pull_request_returns_none_without_a_match(github):
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/pulls")] = httpx.Response(
        200, json=[_pull(3, "feature/login")]
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found is None


def test_find_open_pull_request_ignores_forks_and_other_bases(github):
    """A fork can open a PR from its own `pw/sync-docs-*` branch; committing
    onto that name in this repository would write somewhere else entirely."""
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/pulls")] = httpx.Response(
        200,
        json=[
            _pull(4, "pw/sync-docs-x", head_repo="mallory/make-story-time"),
            _pull(5, "pw/sync-docs-y", base="develop"),
        ],
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found is None


def test_find_open_pull_request_matches_the_repo_case_insensitively(github):
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/pulls")] = httpx.Response(
        200, json=[_pull(6, "pw/sync-docs-x", head_repo="Acme/Make-Story-Time")]
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found is not None and found["number"] == 6


def test_find_open_pull_request_pages_until_a_match(github):
    responses, recorded = github

    def paged(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        if page == 1:
            return httpx.Response(200, json=[_pull(n, f"feature/{n}") for n in range(100)])
        return httpx.Response(200, json=[_pull(300, "pw/sync-docs-x")])

    responses[("GET", f"/repos/{REPO}/pulls")] = paged

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found is not None and found["number"] == 300
    assert [r["params"]["page"] for r in recorded] == ["1", "2"]


def test_find_open_pull_request_stops_after_five_pages(github):
    responses, recorded = github
    responses[("GET", f"/repos/{REPO}/pulls")] = lambda request: httpx.Response(
        200, json=[_pull(n, f"feature/{n}") for n in range(100)]
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request("tok", REPO, "pw/sync-docs-", "main")
    )

    assert found is None
    assert [r["params"]["page"] for r in recorded] == ["1", "2", "3", "4", "5"]


def test_create_pull_request_returns_number_url_and_head(github):
    responses, recorded = github
    responses[("POST", f"/repos/{REPO}/pulls")] = httpx.Response(
        201, json=_pull(12, "pw/sync-docs-x")
    )

    pr = asyncio.run(
        HttpGithubClient().create_pull_request(
            "tok", REPO, "pw/sync-docs-x", "main", "docs: sync", "body text"
        )
    )

    assert pr == {
        "number": 12,
        "html_url": f"https://github.com/{REPO}/pull/12",
        "head": "pw/sync-docs-x",
        "author": "pw-bot",
    }
    assert recorded[0]["json"] == {
        "head": "pw/sync-docs-x",
        "base": "main",
        "title": "docs: sync",
        "body": "body text",
    }


def test_create_pull_request_forbidden_carries_403(github):
    responses, _ = github
    responses[("POST", f"/repos/{REPO}/pulls")] = httpx.Response(
        403, json={"message": "Resource not accessible by personal access token"}
    )

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(
            HttpGithubClient().create_pull_request(
                "tok", REPO, "pw/sync-docs-x", "main", "docs: sync", "body"
            )
        )
    assert excinfo.value.status_code == 403


def test_create_pull_request_that_exists_raises_pull_request_exists(github):
    responses, _ = github
    responses[("POST", f"/repos/{REPO}/pulls")] = httpx.Response(
        422,
        json={
            "message": "Validation Failed",
            "errors": [
                {
                    "resource": "PullRequest",
                    "code": "custom",
                    "message": "A pull request already exists for acme:pw/sync-docs-x.",
                }
            ],
        },
    )

    with pytest.raises(GithubPullRequestExistsError) as excinfo:
        asyncio.run(
            HttpGithubClient().create_pull_request(
                "tok", REPO, "pw/sync-docs-x", "main", "docs: sync", "body"
            )
        )
    assert excinfo.value.status_code == 422


def test_create_pull_request_other_422_is_a_plain_write_error(github):
    responses, _ = github
    responses[("POST", f"/repos/{REPO}/pulls")] = httpx.Response(
        422, json={"message": "Validation Failed", "errors": [{"field": "head"}]}
    )

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(
            HttpGithubClient().create_pull_request(
                "tok", REPO, "pw/sync-docs-x", "main", "docs: sync", "body"
            )
        )
    assert not isinstance(excinfo.value, GithubPullRequestExistsError)


def test_update_pull_request_patches_the_body(github):
    responses, recorded = github
    responses[("PATCH", f"/repos/{REPO}/pulls/12")] = httpx.Response(200, json=_pull(12, "x"))

    asyncio.run(HttpGithubClient().update_pull_request("tok", REPO, 12, "new body"))

    assert recorded == [
        {
            "method": "PATCH",
            "path": f"/repos/{REPO}/pulls/12",
            "params": {},
            "json": {"body": "new body"},
        }
    ]


def test_find_open_pull_request_prefers_the_given_author(github):
    """A collaborator's `pw/sync-docs-*` pull request listed first must not
    hide ours."""
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/pulls")] = httpx.Response(
        200,
        json=[
            _pull(8, "pw/sync-docs-b", login="mallory"),
            _pull(5, "pw/sync-docs-a", login="PW-Bot"),
        ],
    )

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request(
            "tok", REPO, "pw/sync-docs-", "main", author="pw-bot"
        )
    )

    assert found is not None and found["number"] == 5 and found["author"] == "PW-Bot"


def test_find_open_pull_request_falls_back_to_another_author(github):
    responses, recorded = github

    def paged(request: httpx.Request) -> httpx.Response:
        if request.url.params["page"] == "1":
            return httpx.Response(
                200,
                json=[_pull(8, "pw/sync-docs-b", login="mallory")]
                + [_pull(n, f"feature/{n}") for n in range(99)],
            )
        return httpx.Response(200, json=[])

    responses[("GET", f"/repos/{REPO}/pulls")] = paged

    found = asyncio.run(
        HttpGithubClient().find_open_pull_request(
            "tok", REPO, "pw/sync-docs-", "main", author="pw-bot"
        )
    )

    assert found is not None and found["number"] == 8 and found["author"] == "mallory"
    # The search for our own pull request reads past the first foreign match.
    assert [r["params"]["page"] for r in recorded] == ["1", "2"]


def test_compare_files_lists_the_changed_paths(github):
    responses, recorded = github
    path = f"/repos/{REPO}/compare/main...pw/sync-docs-x"
    responses[("GET", path)] = httpx.Response(
        200,
        json={
            "total_commits": 2,
            "commits": [{"sha": "a"}, {"sha": "b"}],
            "files": [{"filename": "AGENTS.md"}, {"filename": ".github/workflows/deploy.yml"}],
        },
    )

    files = asyncio.run(HttpGithubClient().compare_files("tok", REPO, "main", "pw/sync-docs-x"))

    assert files == ["AGENTS.md", ".github/workflows/deploy.yml"]
    assert [(r["method"], r["path"]) for r in recorded] == [("GET", path)]


def test_compare_files_at_githubs_file_cap_is_refused(github):
    """GitHub lists at most 300 files; a comparison at the cap may hide any
    path, so it cannot be shown to touch planning documents only."""
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/compare/main...pw/sync-docs-x")] = httpx.Response(
        200,
        json={"total_commits": 1, "files": [{"filename": f"f{n}.md"} for n in range(300)]},
    )

    with pytest.raises(GithubCompareTooLargeError):
        asyncio.run(HttpGithubClient().compare_files("tok", REPO, "main", "pw/sync-docs-x"))


def test_compare_files_without_a_file_list_is_refused(github):
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/compare/main...pw/sync-docs-x")] = httpx.Response(
        200, json={"total_commits": 400}
    )

    with pytest.raises(GithubCompareTooLargeError):
        asyncio.run(HttpGithubClient().compare_files("tok", REPO, "main", "pw/sync-docs-x"))


def test_compare_files_failure_carries_the_status(github):
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/compare/main...pw/sync-docs-x")] = httpx.Response(
        404, json={"message": "Not Found"}
    )

    with pytest.raises(GithubWriteError) as excinfo:
        asyncio.run(HttpGithubClient().compare_files("tok", REPO, "main", "pw/sync-docs-x"))
    assert not isinstance(excinfo.value, GithubCompareTooLargeError)
    assert excinfo.value.status_code == 404


def test_compare_files_lists_both_names_of_a_renamed_or_copied_file(github):
    """A rename moves a file away from its old path as much as it writes the
    new one: a branch renaming a workflow onto a document path changes the
    workflow too."""
    responses, _ = github
    responses[("GET", f"/repos/{REPO}/compare/main...abc123")] = httpx.Response(
        200,
        json={
            "total_commits": 1,
            "files": [
                {
                    "filename": "docs/scope.md",
                    "previous_filename": ".github/workflows/ci.yml",
                    "status": "renamed",
                },
                {"filename": "AGENTS.md", "previous_filename": "README.md", "status": "copied"},
                {"filename": "docs/tasks.md", "status": "removed"},
            ],
        },
    )

    files = asyncio.run(HttpGithubClient().compare_files("tok", REPO, "main", "abc123"))

    assert files == [
        "docs/scope.md",
        ".github/workflows/ci.yml",
        "AGENTS.md",
        "README.md",
        "docs/tasks.md",
    ]
