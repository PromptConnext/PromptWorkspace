"""`fetch_file_content` against a simulated GitHub contents API.

The repository snapshot (plan 0027 excerpts, plan 0028 outlines) drops a file
that fails to fetch and keeps going — but only when the failure is a
`GithubWriteError`. The contents API answers 200 without a `content` key for
a symlink whose target is outside the repository, a submodule, or a
directory, and a bare `KeyError` from there used to fail the whole analysis,
the same way on every retry. Pinned at the HTTP layer, where the shape lives.
"""

from __future__ import annotations

import asyncio
import base64

import httpx
import pytest

from app.integrations.github import GithubWriteError, HttpGithubClient

REPO = "acme/storyapp"


@pytest.fixture
def contents(monkeypatch):
    """Routes httpx.AsyncClient at a fake contents API. Returns the dict
    mapping path -> the JSON body a GET answers with."""
    bodies: dict[str, object] = {}
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.split("/contents/", 1)[1]
        return httpx.Response(200, json=bodies[path])

    def factory(**kwargs):
        kwargs.pop("transport", None)
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return bodies


def _fetch(path: str) -> str:
    return asyncio.run(HttpGithubClient().fetch_file_content("tok", REPO, path, "abc123"))


def test_a_file_is_decoded(contents):
    contents["src/app.py"] = {
        "type": "file",
        "encoding": "base64",
        "content": base64.b64encode(b"def app(): pass\n").decode(),
    }
    assert _fetch("src/app.py") == "def app(): pass\n"


@pytest.mark.parametrize(
    "body",
    [
        {"type": "symlink", "target": "../outside", "sha": "s1"},
        {"type": "submodule", "submodule_git_url": "https://github.com/a/b.git"},
        [{"type": "file", "name": "a.py"}],
        {"type": "file", "encoding": "none", "content": ""},
    ],
    ids=["symlink", "submodule", "directory", "too-large"],
)
def test_anything_but_a_readable_file_is_a_github_write_error(contents, body):
    contents["src/link"] = body
    with pytest.raises(GithubWriteError):
        _fetch("src/link")
