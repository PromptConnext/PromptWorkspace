"""TypeSafe System One client (https://docs.typesafe.ai/api).

A System One model answers narrow typed questions — a choice among named
options, a yes/no probability, a score on ordered levels — over a piece of
state, rather than generating text. This module only speaks the transport:
one POST, named questions in, named answers out. What to ask, and what the
answers are allowed to decide, belongs to the caller (see
app/deployments/stack_judge.py), because the policy is the part worth
reviewing.

Platform-held key, like MANAGED_MODEL_API_KEY: never a per-user or
per-workspace value, and never sent to a browser.
"""

from __future__ import annotations

from typing import Any, Protocol

import httpx


class TypeSafeError(Exception):
    """Any failure to get a usable answer: transport, HTTP status, or a
    response that does not carry the questions asked. Callers treat every one
    of these the same way — fall back to their deterministic path."""


class TypeSafeClient(Protocol):
    async def evaluate(
        self, state: Any, questions: dict[str, dict[str, Any]]
    ) -> dict[str, dict[str, Any]]: ...


class HttpTypeSafeClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self._api_key = api_key
        self._transport = transport
        self._url = base_url.rstrip("/") + "/systemone"
        self.model = model
        self._timeout = timeout

    async def evaluate(
        self, state: Any, questions: dict[str, dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        payload = {"state": state, "model": self.model, "questions": questions}
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout, transport=self._transport
            ) as client:
                resp = await client.post(
                    self._url,
                    json=payload,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
                resp.raise_for_status()
                answers = resp.json()["answers"]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise TypeSafeError(type(exc).__name__) from exc
        if not isinstance(answers, dict) or not all(q in answers for q in questions):
            raise TypeSafeError("answers_incomplete")
        return answers


class FakeTypeSafeClient:
    """Network-free client for tests: returns canned answers and records every
    call, so a test can assert both what was decided and how often the model
    was asked."""

    def __init__(self, answers: dict[str, dict[str, Any]] | None = None, fail: bool = False):
        self.model = "fake-jev"
        self.answers = answers or {}
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    async def evaluate(
        self, state: Any, questions: dict[str, dict[str, Any]]
    ) -> dict[str, dict[str, Any]]:
        self.calls.append({"state": state, "questions": questions})
        if self.fail:
            raise TypeSafeError("fake_failure")
        return {q: self.answers[q] for q in questions if q in self.answers}
