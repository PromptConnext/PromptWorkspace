"""Stage routing table (M3, plan 0007) — exit criteria under test:

  1. The default table applies with no overrides (constitution/specify/tasks
     -> managed, plan -> byo).
  2. A project override beats a workspace override beats the default.
  3. `plan` resolved to "byo" with no BYO connection errors clearly (409),
     rather than silently falling back to managed or 400ing generically.
  4. A workspace can route `plan` to managed via override and it just works.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.generation.service import FakeGenerationProvider
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

CONSTITUTION_INPUT = "Ship fast, keep it simple, and always write tests before merging any change."
PLAN_INPUT = "Plan out the technical implementation for the payments rollout in detail."


def _managed_connection() -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url="https://api.opentyphoon.ai/v1",
        model="typhoon-v2.5-30b-a3b-instruct",
        embed_model="",
        embed_dim=0,
        secret_ref="unused-in-these-tests",
        daily_token_budget=20_000,
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


def _bootstrap(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_default_table_applied_with_no_overrides(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.get(f"/projects/{pid}/routing", headers=ALICE)
    assert res.status_code == 200, res.text
    by_stage = {r["stage"]: r for r in res.json()["routing"]}
    assert by_stage["constitution"] == {
        "stage": "constitution", "model_source": "managed", "model": None, "origin": "default"
    }
    assert by_stage["specify"]["model_source"] == "managed"
    assert by_stage["tasks"]["model_source"] == "managed"
    assert by_stage["plan"]["model_source"] == "byo"
    assert all(r["origin"] == "default" for r in by_stage.values())


def test_project_override_beats_workspace_override_beats_default(client: TestClient):
    ws_id, pid = _bootstrap(client)

    ws_res = client.put(
        f"/workspaces/{ws_id}/routing",
        json={"stage": "specify", "model_source": "byo"},
        headers=ALICE,
    )
    assert ws_res.status_code == 200, ws_res.text

    res = client.get(f"/projects/{pid}/routing", headers=ALICE)
    by_stage = {r["stage"]: r for r in res.json()["routing"]}
    assert by_stage["specify"] == {
        "stage": "specify", "model_source": "byo", "model": None, "origin": "workspace"
    }

    proj_res = client.put(
        f"/projects/{pid}/routing",
        json={"stage": "specify", "model_source": "managed"},
        headers=ALICE,
    )
    assert proj_res.status_code == 200, proj_res.text

    res = client.get(f"/projects/{pid}/routing", headers=ALICE)
    by_stage = {r["stage"]: r for r in res.json()["routing"]}
    assert by_stage["specify"] == {
        "stage": "specify", "model_source": "managed", "model": None, "origin": "project"
    }

    # The workspace-level override is untouched by the project override —
    # a sibling project with no override of its own still sees it.
    sibling = client.post(
        "/projects", json={"name": "Sibling", "workspace_id": ws_id}, headers=ALICE
    ).json()
    res = client.get(f"/projects/{sibling['id']}/routing", headers=ALICE)
    by_stage = {r["stage"]: r for r in res.json()["routing"]}
    assert by_stage["specify"]["origin"] == "workspace"
    assert by_stage["specify"]["model_source"] == "byo"


def test_plan_with_no_byo_connection_errors_clearly(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.post(
        f"/projects/{pid}/generate/plan", json={"user_input": PLAN_INPUT}, headers=ALICE
    )
    assert res.status_code == 409
    assert "connect a key or route it to the managed tier" in res.json()["detail"]


def test_workspace_can_route_plan_to_managed_via_override(client: TestClient):
    ws_id, pid = _bootstrap(client)

    override = client.put(
        f"/workspaces/{ws_id}/routing",
        json={"stage": "plan", "model_source": "managed"},
        headers=ALICE,
    )
    assert override.status_code == 200, override.text

    res = client.post(
        f"/projects/{pid}/generate/plan", json={"user_input": PLAN_INPUT}, headers=ALICE
    )
    # No requirement exists yet either, but routing resolves before the
    # requirement-prerequisite check — the point under test is that "no BYO
    # connection" no longer blocks plan once it's routed to managed.
    assert res.status_code in (200, 409)
    if res.status_code == 409:
        assert res.json()["detail"] == "requirement_required"


def test_non_admin_cannot_write_workspace_routing(client: TestClient):
    ws_id, _pid = _bootstrap(client)

    res = client.put(
        f"/workspaces/{ws_id}/routing",
        json={"stage": "plan", "model_source": "managed"},
        headers=BOB,
    )
    assert res.status_code == 403
