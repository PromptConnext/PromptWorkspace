"""POST /projects/{id}/prefill/{stage} — drafting the Planner's intake form
from the project's own source material so the author reviews text instead of
typing a dozen fields from a PRD they already wrote.

Exit criteria under test: a draft is grounded in the uploaded document and
keyed by the fields the client asked for; `plan` also reads the specification;
a project with no source material 409s rather than inviting the model to
invent one; unparseable model output fails without touching the form; the
draft is advisory — no graph entity, no stage document; non-members are 403;
budget/rate limits apply as they do to generation.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.generation.prefill import parse_prefill
from app.generation.service import FakeGenerationProvider
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

SPECIFY_FIELDS = [
    {"key": "feature_name", "label": "What are we building?"},
    {"key": "problem", "label": "Problem it solves", "hint": "What hurts today."},
    {"key": "journeys", "label": "Key user journeys"},
]

PRD = b"# PRD\n\nThe rollout must support the Thai QR payment rail codenamed ZEBRA-PAY."


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


def _upload(client: TestClient, pid: str, name: str = "prd.md", body: bytes = PRD):
    return client.post(
        f"/projects/{pid}/documents",
        files={"file": (name, body, "text/markdown")},
        headers=ALICE,
    )


def _prefill(client: TestClient, pid: str, stage: str, fields=None, headers=ALICE):
    return client.post(
        f"/projects/{pid}/prefill/{stage}",
        json={"fields": fields if fields is not None else SPECIFY_FIELDS},
        headers=headers,
    )


def test_specify_draft_is_keyed_by_the_requested_fields_and_grounded_in_the_prd(
    client: TestClient,
):
    _ws_id, pid = _bootstrap(client)
    assert _upload(client, pid).status_code == 201

    res = _prefill(client, pid, "specify")

    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["fields"]) <= {f["key"] for f in SPECIFY_FIELDS}
    assert body["fields"]["feature_name"]
    assert "ZEBRA-PAY" in body["fields"]["feature_name"]
    assert body["sources"] == ["prd.md"]


def test_plan_draft_also_reads_the_specification_already_written(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _upload(client, pid)
    client.patch(
        f"/projects/{pid}/stage-documents/specify",
        json={"content": "# Spec\n\nSettlement happens through the CLEARWAY gateway."},
        headers=ALICE,
    )

    res = _prefill(client, pid, "plan", fields=[{"key": "language", "label": "Language"}])

    assert res.status_code == 200, res.text
    assert "CLEARWAY" in res.json()["fields"]["language"]
    assert "the specification" in res.json()["sources"]


def test_a_project_with_no_source_material_is_rejected_rather_than_invented(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _prefill(client, pid, "specify")

    assert res.status_code == 409
    assert res.json()["detail"] == "no_source_material"


def test_draft_is_advisory_and_writes_nothing(client: TestClient):
    """A prefill must not create the Requirement or the stage document the
    real stage owns — the author has not approved anything yet."""
    _ws_id, pid = _bootstrap(client)
    _upload(client, pid)

    assert _prefill(client, pid, "specify").status_code == 200

    repo = client.app.state.repository
    assert repo.get_latest_requirement(pid) is None
    assert repo.get_stage_document(pid, "specify") is None


def test_unparseable_model_output_fails_without_a_partial_draft(client: TestClient):
    class _Garbage(FakeGenerationProvider):
        async def stream(self, *_args, **_kwargs):
            yield "I'm afraid I can't do that."

    client.app.state.generation_provider = _Garbage()
    _ws_id, pid = _bootstrap(client)
    _upload(client, pid)

    res = _prefill(client, pid, "specify")

    assert res.status_code == 502
    assert res.json()["detail"] == "prefill_unparseable"


def test_non_member_cannot_draft(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _upload(client, pid)

    assert _prefill(client, pid, "specify", headers=BOB).status_code == 403


def test_over_budget_workspace_is_rejected(client: TestClient):
    _ws_id, pid = _bootstrap(client, daily_token_budget=0)
    _upload(client, pid)

    res = _prefill(client, pid, "specify")

    assert res.status_code == 429
    assert res.json()["detail"] == "daily_token_budget_exceeded"


def test_the_run_is_recorded_against_the_workspace(client: TestClient):
    ws_id, pid = _bootstrap(client)
    _upload(client, pid)

    _prefill(client, pid, "specify")

    runs = list(client.app.state.repository._generation_runs.values())
    assert any(
        r.workspace_id == ws_id and r.stage == "prefill:specify" and r.status == "succeeded"
        for r in runs
    )


def test_parse_prefill_normalises_what_models_actually_return():
    fields = [{"key": "journeys", "label": "J"}, {"key": "problem", "label": "P"}]

    drafted = parse_prefill(
        'Here you go:\n```json\n{"journeys": ["Pay by QR", "Export a day"], '
        '"problem": "  Cards only  ", "invented": "ignore me", "blank": ""}\n```',
        fields,
    )

    # Lists become one item per line, values are trimmed, keys the form never
    # asked for are dropped, and an empty answer is left out entirely so the
    # client doesn't blank a field the author already filled in.
    assert drafted == {"journeys": "Pay by QR\nExport a day", "problem": "Cards only"}


def test_parse_prefill_returns_none_when_there_is_no_json_at_all():
    assert parse_prefill("no object here", [{"key": "a", "label": "A"}]) is None
