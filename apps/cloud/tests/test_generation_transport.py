"""Transport-level tests for `stream_openai_chat` (app/rag/chat.py) — the one
OpenAI-compatible streaming call both the RAG assistant and the cloud Planner
go through.

Covers what the endpoint tests can't see because they stub the provider out:
that an explicit `max_tokens` reaches the wire (without it the provider's own
small default silently truncates long stage documents), and that the
`finish_reason` the provider reports comes back to the caller.

There is no pytest asyncio plugin in this suite, so each test drives the async
generator through `asyncio.run` itself.
"""

from __future__ import annotations

import asyncio
import functools
import json

import httpx

from app.rag.chat import stream_openai_chat

MESSAGES = [{"role": "user", "content": "hello"}]


def _chunk(content: str | None = None, finish_reason: str | None = None) -> dict:
    delta = {"content": content} if content is not None else {}
    return {"choices": [{"delta": delta, "finish_reason": finish_reason}]}


def _sse(chunks: list[dict]) -> bytes:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)
    return (body + "data: [DONE]\n\n").encode()


def _run(monkeypatch, finish_reason: str | None, **kwargs) -> tuple[list[httpx.Request], str, list]:
    """Route the client `stream_openai_chat` builds internally through a
    MockTransport (the constructor is the only available seam), replay a
    two-chunk completion ending in `finish_reason`, and return what was sent,
    what was streamed, and what on_finish saw."""
    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(
            200,
            content=_sse([_chunk("Hello "), _chunk("world", finish_reason=finish_reason)]),
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        functools.partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)),
    )

    finishes: list[str | None] = []

    async def drain() -> str:
        text = ""
        async for delta in stream_openai_chat(
            MESSAGES,
            "some-model",
            "some-key",
            "https://example.test/v1",
            on_finish=finishes.append,
            **kwargs,
        ):
            text += delta
        return text

    return sent, asyncio.run(drain()), finishes


def test_max_tokens_is_sent_when_set(monkeypatch):
    sent, text, _finishes = _run(monkeypatch, finish_reason="stop", max_tokens=8_000)

    assert text == "Hello world"
    assert json.loads(sent[0].content)["max_tokens"] == 8_000


def test_max_tokens_is_omitted_when_unset(monkeypatch):
    # Leaves the provider default in force for callers that don't care —
    # the assistant's short chat answers.
    sent, _text, _finishes = _run(monkeypatch, finish_reason="stop")

    assert "max_tokens" not in json.loads(sent[0].content)


def test_finish_reason_length_is_reported(monkeypatch):
    _sent, text, finishes = _run(monkeypatch, finish_reason="length", max_tokens=16)

    assert text == "Hello world"  # the partial completion still streams through
    assert finishes == ["length"]


def test_finish_reason_stop_is_reported(monkeypatch):
    _sent, _text, finishes = _run(monkeypatch, finish_reason="stop", max_tokens=16)

    assert finishes == ["stop"]
