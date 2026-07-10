"""Tests for auto-sync support: the /changes head + rate limiting (M4)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


def _project(client, user="alice"):
    ws = client.post("/workspaces", json={"name": "W"}, headers={"X-User-Id": user}).json()
    proj = client.post(
        "/projects",
        json={"name": "P", "workspace_id": ws["id"]},
        headers={"X-User-Id": user},
    ).json()
    return proj["id"]


def test_changes_head_reports_counts_and_cursor(client):
    pid = _project(client)
    headers = {"X-User-Id": "alice"}
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [{"id": "r1", "project_id": pid, "title": "A"}],
            "tasks": [{"id": "t1", "project_id": pid, "title": "B"}],
        },
        headers=headers,
    )
    head = client.get(f"/sync/projects/{pid}/changes", headers=headers).json()
    assert head["has_changes"] is True
    assert head["counts"] == {"requirements": 1, "tasks": 1}
    assert head["cursor"] is not None


def test_changes_head_empty_fast_path(client):
    pid = _project(client)
    headers = {"X-User-Id": "alice"}
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "A"}]},
        headers=headers,
    )
    cursor = client.get(f"/sync/projects/{pid}/changes", headers=headers).json()["cursor"]

    # Nothing changed since the cursor → has_changes False, no counts.
    head = client.get(
        f"/sync/projects/{pid}/changes", params={"since": cursor}, headers=headers
    ).json()
    assert head["has_changes"] is False
    assert head["counts"] == {}
    # The head cursor is still reported so the client can hold its position.
    assert head["cursor"] is not None


def test_changes_head_detects_new_work(client):
    pid = _project(client)
    headers = {"X-User-Id": "alice"}
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"requirements": [{"id": "r1", "project_id": pid, "title": "A"}]},
        headers=headers,
    )
    cursor = client.get(f"/sync/projects/{pid}/changes", headers=headers).json()["cursor"]
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "B"}]},
        headers=headers,
    )
    head = client.get(
        f"/sync/projects/{pid}/changes", params={"since": cursor}, headers=headers
    ).json()
    assert head["has_changes"] is True
    assert head["counts"] == {"tasks": 1}


# --------------------------------------------------------------------------- #
# Rate limiting
# --------------------------------------------------------------------------- #
@pytest.fixture
def limited_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("RATE_LIMIT_BURST", "3")
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "1")  # negligible refill during the test
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_sync_endpoint_rate_limited_returns_429(limited_client):
    headers = {"X-User-Id": "alice"}
    # The limiter runs before routing, so even a 404 path counts. Burst = 3.
    codes = [
        limited_client.get("/sync/projects/none/changes", headers=headers).status_code
        for _ in range(5)
    ]
    assert 429 in codes
    assert codes[:3] == [404, 404, 404]  # first burst allowed (project missing → 404)
    assert codes[3] == 429  # bucket empty


def test_rate_limit_is_per_identity(limited_client):
    # Alice exhausts her bucket; Bob is unaffected (separate identity).
    for _ in range(4):
        limited_client.get("/sync/projects/none/changes", headers={"X-User-Id": "alice"})
    bob = limited_client.get("/sync/projects/none/changes", headers={"X-User-Id": "bob"})
    assert bob.status_code == 404  # not rate limited
