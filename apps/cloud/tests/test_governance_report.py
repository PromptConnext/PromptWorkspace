"""GET /workspaces/{id}/governance/report (plan 0033, task 10)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.models.schemas import Decision, GenerationRun, utcnow

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture
def workspace(client: TestClient) -> str:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    inv = client.post(
        f"/workspaces/{ws['id']}/invitations", json={"email": "bob@x.com"}, headers=ALICE
    ).json()
    accept = client.post(f"/invitations/{inv['invitation']['token']}/accept", headers=BOB)
    assert accept.status_code == 200
    return ws["id"]


def _project(client, ws, name="P") -> str:
    res = client.post("/projects", json={"name": name, "workspace_id": ws}, headers=ALICE)
    return res.json()["id"]


def _report(client, ws, headers=ALICE):
    return client.get(f"/workspaces/{ws}/governance/report", headers=headers)


def _run(ws, pid, source, stage, tokens, created_at=None, model="m"):
    r = GenerationRun(
        workspace_id=ws, project_id=pid, stage=stage, model_source=source, model=model,
        prompt_tokens=tokens, completion_tokens=tokens,
    )
    if created_at is not None:
        r.created_at = created_at
    return r


def test_report_admin_only(client, workspace):
    assert _report(client, workspace, BOB).status_code == 403
    assert _report(client, workspace).status_code == 200


def test_usage_split_by_source_with_own_budget(client, workspace):
    repo = client.app.state.repository
    pid = _project(client, workspace)
    now = utcnow()
    repo.create_generation_run(_run(workspace, pid, "managed", "specify", 10, now))
    repo.create_generation_run(_run(workspace, pid, "managed", "plan", 5, now - timedelta(days=3)))

    body = _report(client, workspace).json()
    assert [u["source"] for u in body["usage"]] == ["managed"]  # byo has no runs: absent
    m = body["usage"][0]
    assert m["daily_budget"] == client.app.state.settings.managed_daily_token_budget
    assert (m["runs"], m["tokens"], m["today_tokens"]) == (2, 30, 20)
    assert {s["stage"]: s["tokens"] for s in m["by_stage"]} == {"specify": 20, "plan": 10}

    repo.upsert_model_connection(
        workspace_id=workspace, provider="acme", base_url="https://x", model="m",
        embed_model="e", embed_dim=8, secret_ref="s", daily_token_budget=777, created_by="alice",
    )
    repo.create_generation_run(_run(workspace, pid, "byo", "tasks", 4, now))
    usage = {u["source"]: u for u in _report(client, workspace).json()["usage"]}
    assert usage["byo"]["daily_budget"] == 777
    assert usage["byo"]["provider"] == "acme"
    assert usage["byo"]["today_tokens"] == 8
    assert usage["managed"]["daily_budget"] != 777


def _decision(ws, pid, status, hours=None, **kw):
    created = utcnow() - timedelta(days=2)
    d = Decision(
        project_id=pid, workspace_id=ws, kind="intent_approval", title="t",
        subject_stage="specify", subject_hash="h", routed_hat="business_owner",
        status=status, requested_by="alice", created_at=created, **kw,
    )
    if hours is not None:
        d.resolved_at = created + timedelta(hours=hours)
    return d


def test_discipline_counts_and_median(client, workspace):
    repo = client.app.state.repository
    pid = _project(client, workspace)
    assert _report(client, workspace).json()["discipline"]["median_hours_to_decide"] is None
    for status, hours in (("approved", 2), ("rejected", 4), ("approved", 10)):
        repo.save_decision(_decision(workspace, pid, status, hours))
    repo.save_decision(_decision(workspace, pid, "open"))
    repo.save_decision(_decision(workspace, pid, "withdrawn", 1))
    repo.save_decision(_decision(workspace, pid, "expired", 5))
    d = _report(client, workspace).json()["discipline"]
    assert (d["resolved"], d["open"], d["expired_30d"]) == (3, 1, 1)
    assert d["median_hours_to_decide"] == 4


def test_chains_verified_per_project(client, workspace):
    good = _project(client, workspace, "good")
    bad = _project(client, workspace, "bad")
    _project(client, workspace, "none")
    for pid in (good, bad):
        client.put(f"/projects/{pid}/roles/tech_steward", json={"user_id": None}, headers=ALICE)
    chain = client.app.state.repository._receipts[bad]
    chain[0] = chain[0].model_copy(update={"actor": "mallory"})
    body = _report(client, workspace).json()
    assert (body["discipline"]["chains_total"], body["discipline"]["chains_verified"]) == (2, 1)
    assert {p["name"] for p in body["projects"]} == {"good", "bad", "none"}
    assert all(p["checks"] for p in body["projects"])
