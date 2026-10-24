"""PATCH /projects/{id}/tasks/{tid}/status records the closing agent (plan 0033)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from . import test_delivery_api as d
from .test_delivery_api import ALICE, _save_tasks


@pytest.fixture
def client() -> TestClient:
    with TestClient(d.create_app()) as c:
        yield c


@pytest.fixture
def project(client: TestClient) -> str:
    return d.project.__wrapped__(client)


def _task_id(client, project) -> str:
    _save_tasks(client, project)
    plan = client.get(f"/projects/{project}/delivery-plan", headers=ALICE).json()["changes"]
    return plan[1]["task_ids"][0]


def _close(client, project, tid, agent):
    return client.patch(
        f"/projects/{project}/tasks/{tid}/status",
        json={
            "status": "implemented",
            "artifact": {"commit_sha": "b" * 40, "uri": "https://x/c", "agent": agent},
        },
        headers=ALICE,
    )


def test_status_patch_with_agent_422_when_too_long(client, project):
    tid = _task_id(client, project)
    assert _close(client, project, tid, {"client": "c" * 65}).status_code == 422
    assert _close(client, project, tid, {"client": "c", "model": "m" * 129}).status_code == 422


def test_status_patch_records_agent(client, project):
    tid = _task_id(client, project)
    res = _close(client, project, tid, {"client": "claude-code", "model": "opus"})
    assert res.status_code == 200, res.text

    graph = client.get(f"/sync/projects/{project}/graph", headers=ALICE).json()
    mine = [a for a in graph["artifacts"] if a["task_id"] == tid]
    assert [a["agent"] for a in mine] == [{"client": "claude-code", "model": "opus"}]
