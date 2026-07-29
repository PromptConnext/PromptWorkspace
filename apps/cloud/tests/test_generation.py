"""Stage generation endpoints (M1, plan 0007) — cloud-side Spec Kit path,
managed Typhoon only (BYO removed, docs/superpowers/specs/2026-07-25-cloud-
planner-ui-design.md).

Exit criteria under test: each stage streams a parsed artifact; `specify`
visibly reflects a PRD uploaded in M0 via full-text injection (a fact only
present in the uploaded document appears in the generated spec);
`specify`/`plan`/`tasks` persist into the project graph (Requirement /
SpecDocument / Task, the last with `{text: str}[]` acceptance criteria —
CLAUDE.md's shape is unchanged); `plan`/`tasks` 409 without their
prerequisite; a non-member is 403; an over-budget workspace is 429; the run
is recorded in generation_runs.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.generation import _DOCUMENT_CONTEXT_BUDGET, _assemble_document_context
from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.generation.service import FakeGenerationProvider
from app.main import create_app
from app.models.schemas import Document, ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

CONSTITUTION_INPUT = "Ship fast, keep it simple, and always write tests before merging any change."
SPECIFY_INPUT = "Support the new payments rollout across every region we currently operate in."
PLAN_INPUT = "Plan out the technical implementation for the payments rollout in detail."
TASKS_INPUT = "Break the approved implementation plan into small, independently shippable tasks."


def _managed_connection(daily_token_budget: int = 200_000) -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url="https://api.opentyphoon.ai/v1",
        model="typhoon-v2.5-30b-a3b-instruct",
        embed_model="",
        embed_dim=0,
        secret_ref="unused-in-these-tests",
        daily_token_budget=daily_token_budget,
        created_by="platform",
        source="managed",
    )


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.generation_provider = FakeGenerationProvider()
        c.app.state.managed_connection = _managed_connection()
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


def _bootstrap(client: TestClient, daily_token_budget: int = 200_000) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    client.app.state.managed_connection = _managed_connection(daily_token_budget)
    return ws["id"], project["id"]


def _sse_events(body: str) -> dict[str, dict]:
    """Parse the last `data:` payload for each named SSE event out of the
    raw response body."""
    events: dict[str, dict] = {}
    current_event = "message"
    for line in body.splitlines():
        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            payload = line[len("data:") :].strip()
            if payload:
                events[current_event] = json.loads(payload)
    return events


def _generate(client: TestClient, pid: str, stage: str, user_input: str, headers=ALICE):
    return client.post(
        f"/projects/{pid}/generate/{stage}",
        json={"user_input": user_input},
        headers=headers,
    )


def test_constitution_streams_artifact_and_records_run(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", CONSTITUTION_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "content" in events["done"]
    assert events["done"]["content"].startswith("# ")

    repo = client.app.state.repository
    runs = list(repo._generation_runs.values())  # test-only reach into InMemoryRepository internals
    assert any(
        r.workspace_id == ws_id and r.stage == "constitution" and r.status == "succeeded"
        for r in runs
    )


def test_specify_grounds_on_uploaded_document_via_full_text_injection(client: TestClient):
    ws_id, pid = _bootstrap(client)

    upload = client.post(
        f"/projects/{pid}/documents",
        files={
            "file": (
                "prd.md",
                b"# PRD\n\nThe rollout must support the Thai QR payment rail codenamed ZEBRA-PAY.",
                "text/markdown",
            )
        },
        headers=ALICE,
    )
    assert upload.status_code == 201, upload.text
    assert upload.json()["status"] == "extracted"

    # No embedding wait needed — full-text injection reads the document
    # directly, not via the async embed-on-ingest queue.
    res = _generate(client, pid, "specify", SPECIFY_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "ZEBRA-PAY" in events["done"]["content"]

    requirement_id = events["done"]["requirement_id"]
    repo = client.app.state.repository
    requirement = repo.get_latest_requirement(pid)
    assert requirement is not None
    assert requirement.id == requirement_id
    assert requirement.description == SPECIFY_INPUT


def test_successful_generate_autosaves_stage_document(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "specify", SPECIFY_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    generated_content = events["done"]["content"]

    doc_res = client.get(f"/projects/{pid}/stage-documents/specify", headers=ALICE)
    assert doc_res.status_code == 200, doc_res.text
    assert doc_res.json()["content"] == generated_content


def test_plan_requires_a_requirement_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 409


def test_plan_creates_spec_document_against_latest_requirement(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    spec_id = events["done"]["spec_document_id"]

    repo = client.app.state.repository
    spec = repo.get_latest_spec_document(pid)
    assert spec is not None
    assert spec.id == spec_id


def test_tasks_requires_a_spec_document_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 409


def test_tasks_creates_tasks_with_text_acceptance_criteria(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)
    _generate(client, pid, "plan", PLAN_INPUT)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert events["done"]["task_count"] > 0

    repo = client.app.state.repository
    project_store = repo._graph[pid]  # test-only reach into InMemoryRepository internals
    tasks = list(project_store["tasks"].values())
    assert len(tasks) == events["done"]["task_count"]
    for task in tasks:
        assert task.acceptance_criteria
        assert all(hasattr(c, "text") for c in task.acceptance_criteria)


def test_non_member_cannot_generate(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", "hi", headers=BOB)
    assert res.status_code == 403


def test_over_budget_workspace_is_429(client: TestClient):
    _ws_id, pid = _bootstrap(client, daily_token_budget=0)

    res = _generate(client, pid, "constitution", "hi")
    assert res.status_code == 429


def test_assemble_document_context_notes_truncation_of_a_single_oversized_document():
    # Regression: a single document longer than the budget must still surface
    # a truncation note even though there's no *later* document in the loop
    # to trigger the "budget already exhausted" branch.
    oversized_text = "A" * (_DOCUMENT_CONTEXT_BUDGET + 5_000)
    doc = Document(
        workspace_id="ws",
        project_id="p",
        title="huge-prd.md",
        mime="text/markdown",
        storage_ref="ref",
        created_by="alice",
        extracted_text=oversized_text,
    )

    context = _assemble_document_context([doc])

    assert "context budget reached" in context
    injected_text = context.split("\n", 1)[1].rsplit("\n\n(", 1)[0]
    assert len(injected_text) == _DOCUMENT_CONTEXT_BUDGET


class _RecordingProvider:
    """Captures the request-shaping arguments the endpoint passes down, so
    the max_tokens cap can be asserted at the boundary the real HTTP provider
    would use it at."""

    def __init__(self, finish_reason: str | None = "stop", body: str | None = None) -> None:
        self.max_tokens: int | None = None
        self._finish_reason = finish_reason
        self._body = body

    async def stream(
        self,
        system_prompt,
        user_content,
        model,
        api_key,
        base_url,
        max_tokens=None,
        on_finish=None,
    ):
        self.max_tokens = max_tokens
        # extract_document() ignores anything under 80 chars, so the default
        # body is deliberately longer than a token stub.
        yield self._body if self._body is not None else (
            "# Generated Title\n\n## Overview\n\nA generated stage document long enough for the "
            "parser's minimum-length check to accept it as a real document.\n"
        )
        if on_finish is not None:
            on_finish(self._finish_reason)


def test_generation_sends_an_explicit_max_tokens_cap(client: TestClient):
    # Without this, the provider's own (small) default applies and long stage
    # documents come back cut off mid-section.
    provider = _RecordingProvider()
    client.app.state.generation_provider = provider
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", CONSTITUTION_INPUT)

    assert res.status_code == 200, res.text
    assert provider.max_tokens == client.app.state.settings.managed_model_max_tokens
    assert provider.max_tokens > 0


def test_truncated_completion_is_flagged_not_silently_succeeded(client: TestClient):
    client.app.state.generation_provider = _RecordingProvider(finish_reason="length")
    ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "specify", SPECIFY_INPUT)

    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert events["done"]["truncated"] is True
    assert events["done"]["saved"] is True

    repo = client.app.state.repository
    runs = list(repo._generation_runs.values())  # test-only reach into InMemoryRepository internals
    assert [r.status for r in runs if r.stage == "specify"] == ["truncated"]


def test_complete_completion_is_not_flagged_as_truncated(client: TestClient):
    client.app.state.generation_provider = _RecordingProvider(finish_reason="stop")
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "specify", SPECIFY_INPUT)

    events = _sse_events(res.text)
    assert events["done"]["truncated"] is False
    repo = client.app.state.repository
    assert [r.status for r in repo._generation_runs.values() if r.stage == "specify"] == [
        "succeeded"
    ]


def test_unparseable_tasks_output_still_keeps_the_draft(client: TestClient):
    # The stage document is saved before graph persistence, so output the
    # graph rejects (here: a tasks document with no `- [ ] T###` checklist,
    # the shape a truncated generation produces) is still there when the user
    # reopens the project.
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)
    _generate(client, pid, "plan", PLAN_INPUT)
    client.app.state.generation_provider = _RecordingProvider(
        finish_reason="length",
        body=(
            "# Tasks\n\n## Phase 1\n\nProse with no checklist lines at all, long enough to pass "
            "the parser's minimum-length check and reach the task-parsing step.\n"
        ),
    )

    res = _generate(client, pid, "tasks", TASKS_INPUT)

    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert events["error"]["draft_saved"] is True
    assert events["error"]["truncated"] is True

    doc_res = client.get(f"/projects/{pid}/stage-documents/tasks", headers=ALICE)
    assert doc_res.status_code == 200, doc_res.text
    assert "Prose with no checklist lines" in doc_res.json()["content"]


def test_stage_documents_survive_for_a_later_visit(client: TestClient):
    # The Planner refetches every stage on mount; this is the server side of
    # "reopen the project and your generated plans are still there".
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)
    _generate(client, pid, "plan", PLAN_INPUT)

    for stage in ("specify", "plan"):
        doc = client.get(f"/projects/{pid}/stage-documents/{stage}", headers=ALICE).json()
        assert doc["content"].startswith("# ")
        assert doc["updated_at"] is not None
