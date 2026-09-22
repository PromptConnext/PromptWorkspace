"""Who may author which Spec Kit stage.

`plan` is the Tech Lead's technical step — its artifacts are what the project
repository gets seeded from — so authoring it (generate, prefill, save) needs
the workspace admin role. Every other stage stays open to any member, and
reading is never gated: a business user can still open a plan.
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

ALICE = {"X-User-Id": "alice"}  # workspace creator, therefore admin
BOB = {"X-User-Id": "bob"}  # invited member


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.generation_provider = FakeGenerationProvider()
        c.app.state.managed_connection = ModelConnection(
            workspace_id=MANAGED_WORKSPACE_MARKER,
            provider="typhoon",
            base_url="https://api.opentyphoon.ai/v1",
            model="typhoon-v2.5-30b-a3b-instruct",
            embed_model="",
            embed_dim=0,
            secret_ref="unused-in-these-tests",
            daily_token_budget=200_000,
            created_by="platform",
            source="managed",
        )
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


@pytest.fixture
def project(client: TestClient) -> str:
    """A project in Alice's workspace, with Bob accepted as a plain member."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(
        f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB
    )
    assert accept.status_code == 200, accept.text
    return client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]


def test_a_member_cannot_generate_the_plan(client: TestClient, project: str):
    res = client.post(
        f"/projects/{project}/generate/plan", json={"user_input": "stack"}, headers=BOB
    )

    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"


def test_a_member_cannot_draft_or_save_the_plan(client: TestClient, project: str):
    prefill = client.post(
        f"/projects/{project}/prefill/plan",
        json={"fields": [{"key": "language", "label": "Language"}]},
        headers=BOB,
    )
    save = client.patch(
        f"/projects/{project}/stage-documents/plan", json={"content": "# Plan"}, headers=BOB
    )

    assert prefill.status_code == 403
    assert save.status_code == 403


def test_a_member_can_still_read_the_plan(client: TestClient, project: str):
    client.patch(
        f"/projects/{project}/stage-documents/plan", json={"content": "# Plan"}, headers=ALICE
    )

    res = client.get(f"/projects/{project}/stage-documents/plan", headers=BOB)

    assert res.status_code == 200
    assert res.json()["content"] == "# Plan"


def test_a_member_cannot_author_the_constitution(client: TestClient, project: str):
    """The rules live inside the Tech Lead's step and seed AGENTS.md."""
    res = client.patch(
        f"/projects/{project}/stage-documents/constitution",
        json={"content": "# Rules"},
        headers=BOB,
    )

    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"


def test_a_member_can_still_author_the_specification(client: TestClient, project: str):
    """The business framing is exactly who a plain member is."""
    res = client.patch(
        f"/projects/{project}/stage-documents/specify", json={"content": "# Spec"}, headers=BOB
    )

    assert res.status_code == 200, res.text


def test_an_admin_may_author_the_plan(client: TestClient, project: str):
    client.patch(
        f"/projects/{project}/stage-documents/specify", json={"content": "# Spec"}, headers=ALICE
    )

    res = client.patch(
        f"/projects/{project}/stage-documents/plan", json={"content": "# Plan"}, headers=ALICE
    )

    assert res.status_code == 200, res.text


# --------------------------------------------------------------------------- #
# The same rule at the other door (plan 0015 M4)
# --------------------------------------------------------------------------- #
# A `spec_documents` row *is* the `plan` stage's graph projection (the inverse of
# app/generation/stage_apply.py's PROJECTION_NODE_TYPE), so writing one through
# `PUT /sync/projects/{id}/graph` is authoring `plan` by another route. It has to
# refuse the same caller the stage-document PATCH refuses, with the same detail.
def _push_graph(client: TestClient, project: str, body: dict, headers: dict):
    return client.put(f"/sync/projects/{project}/graph", json=body, headers=headers)


def _spec_document(project: str) -> dict:
    return {
        "spec_documents": [
            {
                "id": "s1",
                "project_id": project,
                "requirement_id": "r1",
                "content": "# Plan",
            }
        ]
    }


def test_a_member_cannot_author_the_plan_through_a_graph_push(client: TestClient, project: str):
    res = _push_graph(client, project, _spec_document(project), BOB)

    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "admin_required"
    assert client.get(f"/sync/projects/{project}/graph", headers=BOB).json()["spec_documents"] == []


def test_declaring_source_pmo_does_not_unlock_the_plan_stage(client: TestClient, project: str):
    body = _spec_document(project) | {"source": "pmo"}

    res = _push_graph(client, project, body, BOB)

    assert res.status_code == 403, res.text
    assert res.json()["detail"] == "admin_required"


def test_an_admin_may_author_the_plan_through_a_graph_push(client: TestClient, project: str):
    res = _push_graph(client, project, _spec_document(project), ALICE)

    assert res.status_code == 200, res.text


def test_a_member_may_still_push_the_specification_through_the_graph(
    client: TestClient, project: str
):
    """`specify` is not admin-only, and a requirement is its projection — the
    graph gate must not over-reach into the stages a member owns."""
    res = _push_graph(
        client,
        project,
        {"requirements": [{"id": "r1", "project_id": project, "title": "Log in"}]},
        BOB,
    )

    assert res.status_code == 200, res.text
