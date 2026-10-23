"""Receipts API (D1): read the chain with its verification, export it."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.delivery.receipts import receipt_hash, verify_chain
from app.main import create_app
from app.models.schemas import Receipt

ALICE = {"X-User-Id": "alice"}
EVE = {"X-User-Id": "eve"}


@pytest.fixture
def client():
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def project(client):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    pid = client.post("/projects", json={"name": "P", "workspace_id": ws["id"]},
                      headers=ALICE).json()["id"]
    for user in ("u1", "u2", None):
        client.put(f"/projects/{pid}/roles/tech_steward", json={"user_id": user}, headers=ALICE)
    return pid


def test_members_read_the_chain_with_a_passing_verification(client, project):
    # u1/u2 are not members, so only the final clear succeeds: one receipt.
    body = client.get(f"/projects/{project}/receipts", headers=ALICE).json()
    assert [r["event"] for r in body["receipts"]] == ["role.cleared"]
    assert body["verification"] == {"ok": True, "count": 1,
                                    "head": body["receipts"][0]["hash"],
                                    "broken_at": None, "reason": None}


def test_a_tampered_receipt_is_reported(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": None}, headers=ALICE)
    chain = client.app.state.repository._receipts[project]
    chain[0] = chain[0].model_copy(update={"actor": "mallory"})

    body = client.get(f"/projects/{project}/receipts", headers=ALICE).json()
    assert body["verification"]["ok"] is False
    assert body["verification"]["broken_at"] == 1
    assert body["verification"]["reason"] == "hash_mismatch"


def test_the_export_is_one_receipt_per_line_and_verifies_offline(client, project):
    client.put(f"/projects/{project}/roles/business_owner", json={"user_id": None}, headers=ALICE)
    res = client.get(f"/projects/{project}/receipts.jsonl", headers=ALICE)

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/x-ndjson")
    assert f'receipts-{project}.jsonl' in res.headers["content-disposition"]
    receipts = [Receipt(**json.loads(line)) for line in res.text.splitlines()]
    assert len(receipts) == 2
    assert all(receipt_hash(r) == r.hash for r in receipts)
    assert verify_chain(receipts).ok


def test_non_members_cannot_read_receipts(client, project):
    assert client.get(f"/projects/{project}/receipts", headers=EVE).status_code == 403
    assert client.get(f"/projects/{project}/receipts.jsonl", headers=EVE).status_code == 403
