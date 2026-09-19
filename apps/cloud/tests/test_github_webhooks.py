"""Repository-webhook registration at GitHub's HTTP boundary."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.integrations.github import (
    WEBHOOK_EVENTS,
    FakeGithubClient,
    GithubWriteError,
    HttpGithubClient,
)


def _respond_with(monkeypatch, response: httpx.Response) -> None:
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(
            transport=httpx.MockTransport(lambda _request: response), **kwargs
        ),
    )


def test_create_repo_webhook_recognizes_only_githubs_duplicate_hook_422(monkeypatch):
    _respond_with(
        monkeypatch,
        httpx.Response(
            422,
            json={
                "message": "Validation Failed",
                "errors": [
                    {
                        "resource": "Hook",
                        "code": "custom",
                        "message": "Hook already exists on this repository",
                    }
                ],
            },
        ),
    )

    created = asyncio.run(
        HttpGithubClient().create_repo_webhook(
            "token", "acme/rocket-ship", "https://cloud.example.com/api/webhooks/github", "secret"
        )
    )

    assert created is False


def test_create_repo_webhook_raises_for_a_nonduplicate_422(monkeypatch):
    _respond_with(
        monkeypatch,
        httpx.Response(
            422,
            json={
                "message": "Validation Failed",
                "errors": [
                    {
                        "resource": "Hook",
                        "code": "invalid",
                        "message": "config.url is not a valid URL",
                    }
                ],
            },
        ),
    )

    with pytest.raises(GithubWriteError) as exc:
        asyncio.run(
            HttpGithubClient().create_repo_webhook(
                "token", "acme/rocket-ship", "https://not a url", "secret"
            )
        )

    assert exc.value.status_code == 422


def test_create_repo_webhook_rejects_a_mixed_duplicate_422(monkeypatch):
    """A duplicate-looking entry cannot hide an additional validation error."""
    _respond_with(
        monkeypatch,
        httpx.Response(
            422,
            json={
                "message": "Validation Failed",
                "errors": [
                    {
                        "resource": "Hook",
                        "code": "custom",
                        "message": "Hook already exists on this repository",
                    },
                    {
                        "resource": "Hook",
                        "code": "invalid",
                        "message": "config.url is not a valid URL",
                    },
                ],
            },
        ),
    )

    with pytest.raises(GithubWriteError) as exc:
        asyncio.run(
            HttpGithubClient().create_repo_webhook(
                "token",
                "acme/rocket-ship",
                "https://cloud.example.com/api/webhooks/github",
                "secret",
            )
        )

    assert exc.value.status_code == 422


def test_fake_webhook_duplicate_detection_keeps_distinct_callback_urls():
    fake = FakeGithubClient()

    async def register() -> list[bool]:
        return [
            await fake.create_repo_webhook(
                "token", "acme/rocket-ship", "https://one.test/hook", "one"
            ),
            await fake.create_repo_webhook(
                "token", "acme/rocket-ship", "https://one.test/hook", "two"
            ),
            await fake.create_repo_webhook(
                "token", "acme/rocket-ship", "https://two.test/hook", "three"
            ),
        ]

    assert asyncio.run(register()) == [True, False, True]
    assert fake.webhooks == [
        {
            "repo": "acme/rocket-ship",
            "url": "https://one.test/hook",
            "secret": "one",
            "events": list(WEBHOOK_EVENTS),
        },
        {
            "repo": "acme/rocket-ship",
            "url": "https://two.test/hook",
            "secret": "three",
            "events": list(WEBHOOK_EVENTS),
        },
    ]


def test_rotate_repo_hook_secret_patches_the_existing_hook(monkeypatch):
    requests: list[httpx.Request] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={})

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs),
    )

    asyncio.run(
        HttpGithubClient().rotate_repo_hook_secret(
            "token",
            "acme/rocket-ship",
            42,
            "https://cloud.example.com/api/webhooks/github",
            "new-secret",
            list(WEBHOOK_EVENTS),
        )
    )

    assert len(requests) == 1
    request = requests[0]
    assert request.method == "PATCH"
    assert request.url.path == "/repos/acme/rocket-ship/hooks/42"
    assert json.loads(request.content) == {
        "events": list(WEBHOOK_EVENTS),
        "config": {
            "url": "https://cloud.example.com/api/webhooks/github",
            "content_type": "json",
            "secret": "new-secret",
            "insecure_ssl": "0",
        },
    }
