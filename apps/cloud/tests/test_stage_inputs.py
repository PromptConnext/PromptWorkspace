"""GET/PUT /projects/{id}/stage-inputs/{stage} — the Planner's form answers.

The stage document is what a generation produced; these are what the author
asked for. Kept server-side so a teammate, or the same author on another
device, reopens the form with the answers rather than empty fields.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

ALICE = {"X-User-Id": "alice"}  # workspace creator, therefore admin
BOB = {"X-User-Id": "bob"}  # invited member
MALLORY = {"X-User-Id": "mallory"}  # not a member


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def project(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    invitation = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{invitation['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200, accept.text
    return client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]


def test_get_is_empty_before_anything_is_saved(client: TestClient, project: str):
    res = client.get(f"/projects/{project}/stage-inputs/specify", headers=ALICE)

    assert res.status_code == 200, res.text
    assert res.json() == {"stage": "specify", "inputs": {}, "updated_at": None, "updated_by": None}


def test_put_then_get_round_trips_for_another_member(client: TestClient, project: str):
    answers = {"problem": "Riders wait too long", "audience": "Commuters"}
    put = client.put(
        f"/projects/{project}/stage-inputs/specify", json={"inputs": answers}, headers=BOB
    )
    assert put.status_code == 200, put.text
    assert put.json()["inputs"] == answers
    assert put.json()["updated_by"] == "bob"
    assert put.json()["updated_at"]

    # Shared by the project's members, not per-user.
    got = client.get(f"/projects/{project}/stage-inputs/specify", headers=ALICE).json()
    assert got["inputs"] == answers
    assert got["updated_by"] == "bob"


def test_put_replaces_rather_than_merges(client: TestClient, project: str):
    url = f"/projects/{project}/stage-inputs/specify"
    client.put(url, json={"inputs": {"a": "1", "b": "2"}}, headers=ALICE)
    client.put(url, json={"inputs": {"a": "3"}}, headers=ALICE)

    assert client.get(url, headers=ALICE).json()["inputs"] == {"a": "3"}


def test_stages_are_independent(client: TestClient, project: str):
    client.put(
        f"/projects/{project}/stage-inputs/specify", json={"inputs": {"a": "s"}}, headers=ALICE
    )
    client.put(
        f"/projects/{project}/stage-inputs/plan", json={"inputs": {"a": "p"}}, headers=ALICE
    )

    assert client.get(f"/projects/{project}/stage-inputs/specify", headers=ALICE).json()[
        "inputs"
    ] == {"a": "s"}
    assert client.get(f"/projects/{project}/stage-inputs/plan", headers=ALICE).json()[
        "inputs"
    ] == {"a": "p"}


def test_saving_answers_does_not_create_a_stage_document(client: TestClient, project: str):
    """The Planner's done-state reads the stage document; an answers-only save
    must not look like a generated stage."""
    client.put(
        f"/projects/{project}/stage-inputs/specify", json={"inputs": {"a": "x"}}, headers=ALICE
    )

    doc = client.get(f"/projects/{project}/stage-documents/specify", headers=ALICE).json()
    assert doc["id"] is None
    assert doc["content"] == ""


# --- access ------------------------------------------------------------------


def test_a_non_member_can_neither_read_nor_write(client: TestClient, project: str):
    url = f"/projects/{project}/stage-inputs/specify"
    assert client.get(url, headers=MALLORY).status_code == 403
    put = client.put(url, json={"inputs": {"a": "x"}}, headers=MALLORY)
    assert put.status_code == 403
    assert put.json()["detail"] == "not_a_member"


def test_an_unknown_project_is_404(client: TestClient):
    res = client.put(
        "/projects/does-not-exist/stage-inputs/specify", json={"inputs": {}}, headers=ALICE
    )
    assert res.status_code == 404


@pytest.mark.parametrize("stage", ["plan", "constitution"])
def test_a_member_cannot_save_answers_for_an_admin_stage(
    client: TestClient, project: str, stage: str
):
    """Same rule as generating or saving that stage (ADMIN_ONLY_STAGES)."""
    res = client.put(
        f"/projects/{project}/stage-inputs/{stage}", json={"inputs": {"a": "x"}}, headers=BOB
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"
    generate = client.post(
        f"/projects/{project}/generate/{stage}", json={"user_input": "x"}, headers=BOB
    )
    assert generate.json()["detail"] == res.json()["detail"]


def test_a_member_can_read_admin_stage_answers(client: TestClient, project: str):
    client.put(
        f"/projects/{project}/stage-inputs/plan", json={"inputs": {"lang": "Go"}}, headers=ALICE
    )
    res = client.get(f"/projects/{project}/stage-inputs/plan", headers=BOB)
    assert res.status_code == 200
    assert res.json()["inputs"] == {"lang": "Go"}


# --- validation --------------------------------------------------------------


def _put(client: TestClient, project: str, body) -> int:
    return client.put(
        f"/projects/{project}/stage-inputs/specify", json=body, headers=ALICE
    ).status_code


def test_a_stage_without_a_form_is_rejected(client: TestClient, project: str):
    res = client.put(f"/projects/{project}/stage-inputs/tasks", json={"inputs": {}}, headers=ALICE)
    assert res.status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"inputs": {"a": 1}},
        {"inputs": {"a": None}},
        {"inputs": {"a": ["x"]}},
        {"inputs": {"a": {"b": "c"}}},
        {"inputs": ["a"]},
        {"inputs": "a"},
        {},
        {"inputs": {"a": "x"}, "extra": True},
    ],
)
def test_non_string_answers_are_rejected(client: TestClient, project: str, body):
    assert _put(client, project, body) == 422


def test_at_most_forty_answers(client: TestClient, project: str):
    assert _put(client, project, {"inputs": {f"k{i}": "v" for i in range(40)}}) == 200
    assert _put(client, project, {"inputs": {f"k{i}": "v" for i in range(41)}}) == 422


def test_each_answer_is_capped_at_twenty_thousand_characters(client: TestClient, project: str):
    assert _put(client, project, {"inputs": {"a": "x" * 20_000}}) == 200
    assert _put(client, project, {"inputs": {"a": "x" * 20_001}}) == 422


def test_keys_must_be_short_and_non_empty(client: TestClient, project: str):
    assert _put(client, project, {"inputs": {"": "x"}}) == 422
    assert _put(client, project, {"inputs": {"k" * 101: "x"}}) == 422


def test_a_rejected_put_leaves_the_stored_answers_alone(client: TestClient, project: str):
    url = f"/projects/{project}/stage-inputs/specify"
    client.put(url, json={"inputs": {"a": "kept"}}, headers=ALICE)
    client.put(url, json={"inputs": {"a": 1}}, headers=ALICE)

    assert client.get(url, headers=ALICE).json()["inputs"] == {"a": "kept"}


# --- soft fail ---------------------------------------------------------------


def test_storage_not_migrated_yet_reads_empty_and_refuses_writes_with_503(
    client: TestClient, project: str
):
    """Code deployed ahead of migration 0003: the form still loads (empty)
    and a save says so instead of 500ing."""
    from app.db.repository import StageInputsUnavailable

    repo = client.app.state.repository

    def unavailable(*_args, **_kwargs):
        raise StageInputsUnavailable()

    repo.upsert_stage_inputs = unavailable
    repo.get_stage_inputs = lambda *_a, **_k: None

    url = f"/projects/{project}/stage-inputs/specify"
    got = client.get(url, headers=ALICE)
    assert got.status_code == 200
    assert got.json()["inputs"] == {}

    put = client.put(url, json={"inputs": {"a": "x"}}, headers=ALICE)
    assert put.status_code == 503
    assert put.json()["detail"] == "stage_inputs_unavailable"
