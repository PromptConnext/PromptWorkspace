"""`put_file_content` against a simulated GitHub contents API.

The seeding step at tech-review exit writes into a repo created with
`auto_init=true`, so README.md already exists before the first seed file is
written. GitHub's contents API answers a blind PUT over an existing path with
422 ("sha wasn't supplied"), which is neither a token-scope error nor a
transient one — the caller's "try again" would loop forever on it. So the
upsert behaviour is pinned here at the HTTP layer, where the bug lived;
FakeGithubClient's dict-overwrite can't express the distinction.

There is no pytest asyncio plugin in this suite, so each test drives the
coroutine through `asyncio.run` itself, with httpx.MockTransport standing in
for api.github.com.
"""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest

from app.integrations.github import (
    GithubBranchMovedError,
    GithubRefUpdateRejectedError,
    GithubWriteError,
    HttpGithubClient,
)

REPO = "acme/make-story-time"
EXISTING_SHA = "6515b55d5f456f846e8735f4c29c639180892a5d"


def _github(existing: dict[str, str], recorder: list[dict]):
    """Handler mimicking the two contents-API behaviours that matter: GET
    404s for an unknown path, and PUT 422s over a known one unless the request
    carries that blob's sha."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.split("/contents/", 1)[1]
        if request.method == "GET":
            if path not in existing:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"sha": existing[path], "type": "file"})
        body = json.loads(request.content)
        recorder.append({"path": path, "sha": body.get("sha")})
        if path in existing and body.get("sha") != existing[path]:
            return httpx.Response(
                422,
                json={"message": 'Invalid request.\n\n"sha" wasn\'t supplied.'},
            )
        existing[path] = f"new-sha-{path}"
        return httpx.Response(200, json={"content": {"sha": existing[path]}})

    return handler


@pytest.fixture
def transport(monkeypatch):
    """Routes every httpx.AsyncClient in the module under test at a fake
    GitHub. Returns (existing_files, recorded_put_bodies)."""
    existing: dict[str, str] = {}
    recorder: list[dict] = []
    real_client = httpx.AsyncClient

    def factory(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(_github(existing, recorder)), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return existing, recorder


def test_writes_new_file_without_a_sha(transport):
    existing, recorder = transport

    sha = asyncio.run(
        HttpGithubClient().put_file_content(
            "tok", REPO, "AGENTS.md", "rules", message="chore: seed", branch="main"
        )
    )

    assert sha == "new-sha-AGENTS.md"
    assert recorder == [{"path": "AGENTS.md", "sha": None}]


def test_overwrites_the_auto_init_readme(transport):
    """The regression: seeding used to die here on the second file."""
    existing, recorder = transport
    existing["README.md"] = EXISTING_SHA

    sha = asyncio.run(
        HttpGithubClient().put_file_content(
            "tok", REPO, "README.md", "# Project", message="chore: seed", branch="main"
        )
    )

    assert sha == "new-sha-README.md"
    assert recorder == [{"path": "README.md", "sha": EXISTING_SHA}]


def test_caller_supplied_sha_skips_the_lookup(transport):
    existing, recorder = transport
    existing["README.md"] = EXISTING_SHA

    asyncio.run(
        HttpGithubClient().put_file_content(
            "tok",
            REPO,
            "README.md",
            "# Project",
            message="chore: seed",
            branch="main",
            sha=EXISTING_SHA,
        )
    )

    assert recorder == [{"path": "README.md", "sha": EXISTING_SHA}]


def test_write_failure_still_surfaces_its_status(transport):
    """The lookup must not swallow a real PUT error: a conflicting sha (a
    concurrent write) still raises with GitHub's own status attached."""
    existing, recorder = transport
    existing["README.md"] = EXISTING_SHA

    with pytest.raises(GithubWriteError) as exc:
        asyncio.run(
            HttpGithubClient().put_file_content(
                "tok",
                REPO,
                "README.md",
                "# Project",
                message="chore: seed",
                branch="main",
                sha="stale-sha",
            )
        )

    assert exc.value.status_code == 422


def test_unreachable_github_is_a_write_error_not_a_raw_transport_error(monkeypatch):
    """api/sync.py branches on GithubWriteError; an httpx timeout escaping
    this layer would bypass all of it and surface as a bare 500."""
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )

    with pytest.raises(GithubWriteError) as exc:
        asyncio.run(
            HttpGithubClient().put_file_content(
                "tok", REPO, "AGENTS.md", "rules", message="chore: seed", branch="main"
            )
        )

    # No status: a transport failure is transient, and every caller's
    # 403/404 "fix your token" branch must not claim it.
    assert exc.value.status_code is None


def test_get_repo_raises_on_a_status_that_is_not_404(monkeypatch):
    """404 means "no such repo" (adoptable answer: None); 403 means the token
    cannot see it and must reach the caller as an error carrying its status."""
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"message": "Resource not accessible by PAT"})

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )

    with pytest.raises(GithubWriteError) as exc:
        asyncio.run(HttpGithubClient().get_repo("tok", REPO))

    assert exc.value.status_code == 403


def test_get_repo_returns_none_for_a_missing_repo(monkeypatch):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_client(
            transport=httpx.MockTransport(lambda req: httpx.Response(404, json={})), **kw
        ),
    )

    assert asyncio.run(HttpGithubClient().get_repo("tok", REPO)) is None


def test_sends_utf8_base64_content(monkeypatch):
    """Seed files carry the project's own prose — non-ASCII must survive."""
    captured: list[str] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(404, json={"message": "Not Found"})
        captured.append(json.loads(request.content)["content"])
        return httpx.Response(200, json={"content": {"sha": "s"}})

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    asyncio.run(
        HttpGithubClient().put_file_content(
            "tok", REPO, "docs/scope.md", "ขอบเขต", message="chore: seed", branch="main"
        )
    )

    assert base64.b64decode(captured[0]).decode("utf-8") == "ขอบเขต"


# --------------------------------------------------------------------------- #
# Seed commits pinned to an inspected head, and tree entries (plan 0027)
# --------------------------------------------------------------------------- #


NOT_FAST_FORWARD = "Update is not a fast forward"
PROTECTED = (
    "Protected branch update failed for refs/heads/main: "
    "Changes must be made through a pull request."
)


def _git_data(head: str, ref_update_status: int = 200, ref_message: str = NOT_FAST_FORWARD):
    """Handler for the Git Data API calls `create_commit_with_files` makes.
    Returns (handler, calls) — calls records (method, path) in order."""
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        calls.append((request.method, path))
        if path.endswith("/git/ref/heads/main"):
            return httpx.Response(200, json={"object": {"sha": head}})
        if "/git/commits/" in path:
            return httpx.Response(200, json={"tree": {"sha": "base-tree"}})
        if path.endswith("/git/blobs"):
            return httpx.Response(201, json={"sha": "blob-1"})
        if path.endswith("/git/trees"):
            return httpx.Response(201, json={"sha": "new-tree"})
        if path.endswith("/git/commits"):
            assert json.loads(request.content)["parents"] == [head]
            return httpx.Response(201, json={"sha": "new-commit"})
        if path.endswith("/git/refs/heads/main"):
            if ref_update_status != 200:
                return httpx.Response(ref_update_status, json={"message": ref_message})
            return httpx.Response(200, json={"object": {"sha": "new-commit"}})
        raise AssertionError(f"unexpected {request.method} {path}")

    return handler, calls


def _route(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )


def _seed_commit(expected_base_sha: str | None) -> str:
    from app.integrations.repo_seed import SeedFile

    return asyncio.run(
        HttpGithubClient().create_commit_with_files(
            "tok",
            REPO,
            "main",
            [SeedFile("AGENTS.md", "rules")],
            "chore: seed",
            expected_base_sha=expected_base_sha,
        )
    )


def test_a_seed_commit_on_the_inspected_head_lands(monkeypatch):
    handler, _calls = _git_data(head="inspected")
    _route(monkeypatch, handler)
    assert _seed_commit("inspected") == "new-commit"


def test_a_moved_branch_refuses_before_writing_anything(monkeypatch):
    handler, calls = _git_data(head="someone-else")
    _route(monkeypatch, handler)

    with pytest.raises(GithubBranchMovedError):
        _seed_commit("inspected")
    assert all(method == "GET" for method, _path in calls)


def test_a_branch_moving_during_the_commit_is_reported_as_moved(monkeypatch):
    handler, _calls = _git_data(head="inspected", ref_update_status=422)
    _route(monkeypatch, handler)

    with pytest.raises(GithubBranchMovedError):
        _seed_commit("inspected")


@pytest.mark.parametrize("pin", ["inspected", None])
def test_a_protected_branch_is_not_reported_as_moved(monkeypatch, pin):
    """A 422 that is not a lost race — branch protection, a ruleset — would
    refuse every retry, so it must not read as a moved branch."""
    handler, _calls = _git_data(head="inspected", ref_update_status=422, ref_message=PROTECTED)
    _route(monkeypatch, handler)

    with pytest.raises(GithubRefUpdateRejectedError) as exc:
        _seed_commit(pin)
    assert not isinstance(exc.value, GithubBranchMovedError)
    assert exc.value.status_code == 422


def test_a_non_fast_forward_without_a_pin_is_also_a_moved_branch(monkeypatch):
    handler, _calls = _git_data(
        head="whatever", ref_update_status=422, ref_message="Update is not a fast-forward"
    )
    _route(monkeypatch, handler)

    with pytest.raises(GithubBranchMovedError):
        _seed_commit(None)


def test_other_ref_update_failures_stay_plain_write_errors(monkeypatch):
    handler, _calls = _git_data(head="inspected", ref_update_status=500, ref_message="boom")
    _route(monkeypatch, handler)

    with pytest.raises(GithubWriteError) as exc:
        _seed_commit("inspected")
    assert type(exc.value) is GithubWriteError


def test_tree_entries_keep_directories_and_submodules(monkeypatch):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "truncated": True,
                "tree": [
                    {"path": "docs", "type": "commit", "sha": "sub"},
                    {"path": "src", "type": "tree", "sha": "t1"},
                    {"path": "src/a.ts", "type": "blob", "sha": "b1"},
                ],
            },
        )

    _route(monkeypatch, handler)
    client = HttpGithubClient()
    entries, truncated = asyncio.run(client.get_tree_entries("tok", REPO, "head"))
    assert truncated is True
    assert [(e["path"], e["type"]) for e in entries] == [
        ("docs", "commit"),
        ("src", "tree"),
        ("src/a.ts", "blob"),
    ]
    paths, _ = asyncio.run(client.get_tree("tok", REPO, "head"))
    assert paths == ["src/a.ts"]
    asyncio.run(client.get_tree_entries("tok", REPO, "t1", recursive=False))
    assert seen[0] == {"recursive": "1"} and seen[-1] == {}
