"""Tests for the Jira/ClickUp mirror (M5): pure adapters + end-to-end flow."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.integrations.clickup import ClickUpAdapter
from app.integrations.jira import JiraAdapter
from app.main import create_app
from app.models.schemas import AcceptanceCriterion, Task, TaskStatus
from tests._tracker import account_secret

JIRA_CONFIG = {"base_url": "https://acme.atlassian.net", "project_key": "PZ"}


# --------------------------------------------------------------------------- #
# Pure adapter mapping
# --------------------------------------------------------------------------- #
def test_jira_build_push_maps_fields():
    task = Task(
        id="t1",
        project_id="p1",
        title="Build login",
        feature_tag="auth epic",
        acceptance_criteria=[AcceptanceCriterion(text="Email + password")],
    )
    req = JiraAdapter().build_push(task, JIRA_CONFIG)
    assert req.method == "POST"
    assert req.url == "https://acme.atlassian.net/rest/api/3/issue"
    fields = req.json["fields"]
    assert fields["project"] == {"key": "PZ"}
    assert fields["summary"] == "Build login"
    assert fields["description"] == "Email + password"
    assert fields["labels"] == ["auth-epic"]  # spaces stripped for Jira labels


def test_jira_status_map_and_transition():
    adapter = JiraAdapter()
    assert adapter.jira_status_name(TaskStatus.verified, JIRA_CONFIG) == "Done"
    assert adapter.jira_status_name(TaskStatus.in_progress, JIRA_CONFIG) == "In Progress"
    req = adapter.build_transition("PZ-42", "31", JIRA_CONFIG)
    assert req.url.endswith("/rest/api/3/issue/PZ-42/transitions")
    assert req.json == {"transition": {"id": "31"}}


def test_jira_webhook_parses_pmo_fields():
    payload = {
        "webhookEvent": "jira:issue_updated",
        "issue": {
            "key": "PZ-42",
            "fields": {
                "assignee": {"displayName": "Alice"},
                "status": {"name": "In Progress"},
            },
        },
    }
    updates = JiraAdapter().handle_webhook(payload, JIRA_CONFIG)
    assert len(updates) == 1
    u = updates[0]
    assert u.external_key == "PZ-42"
    assert u.assignee == "Alice"
    assert u.status == TaskStatus.in_progress


def test_jira_signature_verification():
    adapter = JiraAdapter()
    body = b'{"a":1}'
    secret = "shh"
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert adapter.verify_signature(body, f"sha256={sig}", secret) is True
    assert adapter.verify_signature(body, sig, secret) is True
    assert adapter.verify_signature(body, "deadbeef", secret) is False
    assert adapter.verify_signature(body, None, secret) is False


def test_clickup_adapter_conforms_to_interface():
    task = Task(id="t1", project_id="p1", title="X", status=TaskStatus.in_progress)
    req = ClickUpAdapter().build_push(task, {"project_key": "list-9"})
    assert req.url.endswith("/api/v2/list/list-9/task")
    assert req.json["name"] == "X"
    assert req.json["status"] == "in progress"


# --------------------------------------------------------------------------- #
# End-to-end through the API
# --------------------------------------------------------------------------- #
# There is no longer a process-wide JIRA_WEBHOOK_SECRET (plan 0019). The inbound
# secret is minted per Jira site by `configure_integration` and held as
# ciphertext, so a test that wants to sign a delivery has to read the site's own
# secret back out of the repository — see `account_secret` below.


@pytest.fixture
def jira_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("JIRA_EMAIL", "bot@acme.com")
    monkeypatch.setenv("JIRA_API_TOKEN", "token-123")
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def _bootstrap(client, monkeypatch):
    """Create ws + project + task, configure Jira, and mirror the task (with a
    stubbed outbound call) so a task link exists. Returns (pid, tid)."""
    ws = client.post("/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}).json()
    pid = client.post(
        "/projects",
        json={"name": "P", "workspace_id": ws["id"]},
        headers={"X-User-Id": "alice"},
    ).json()["id"]
    client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "tasks": [
                {"id": "t1", "project_id": pid, "title": "Login", "status": "in_progress"}
            ]
        },
        headers={"X-User-Id": "alice"},
    )
    cfg = client.post(
        f"/workspaces/{ws['id']}/integrations/jira",
        json=JIRA_CONFIG,
        headers={"X-User-Id": "alice"},
    )
    assert cfg.status_code == 200, cfg.text

    # Stub the outbound Jira call so mirror records a link without a network.
    import app.api.integrations as integ

    monkeypatch.setattr(integ, "_send", lambda outbound, auth: {"key": "PZ-1"})
    link = client.post(
        f"/projects/{pid}/tasks/t1/mirror",
        params={"provider": "jira"},
        headers={"X-User-Id": "alice"},
    )
    assert link.status_code == 200, link.text
    assert link.json()["external_key"] == "PZ-1"
    # Stamped from the workspace's own integration row, never from the caller.
    assert link.json()["account_key"] == "https://acme.atlassian.net"
    return ws["id"], pid


def test_configure_integration_requires_admin(jira_client):
    ws = jira_client.post(
        "/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}
    ).json()
    # Non-member/non-admin bob is rejected.
    res = jira_client.post(
        f"/workspaces/{ws['id']}/integrations/jira",
        json=JIRA_CONFIG,
        headers={"X-User-Id": "bob"},
    )
    assert res.status_code == 403


def test_configure_rejects_non_allowlisted_base_url(jira_client):
    ws = jira_client.post(
        "/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}
    ).json()
    # An attacker-controlled host would exfiltrate the outbound Jira token.
    evil = jira_client.post(
        f"/workspaces/{ws['id']}/integrations/jira",
        json={"base_url": "https://evil.example.com", "project_key": "PZ"},
        headers={"X-User-Id": "alice"},
    )
    assert evil.status_code == 422
    # http (non-TLS) is also rejected.
    insecure = jira_client.post(
        f"/workspaces/{ws['id']}/integrations/jira",
        json={"base_url": "http://acme.atlassian.net", "project_key": "PZ"},
        headers={"X-User-Id": "alice"},
    )
    assert insecure.status_code == 422


def test_webhook_updates_only_pmo_fields(jira_client, monkeypatch):
    ws_id, pid = _bootstrap(jira_client, monkeypatch)

    # Jira says: assignee=Bob, status=Done. Only assignee (pmo) must land;
    # status (pz) must stay in_progress — proving the M3 boundary end-to-end.
    # `issue.self` is what identifies the sending site (plan 0019 M2) and so
    # which account's secret the signature is checked against.
    payload = {
        "webhookEvent": "jira:issue_updated",
        "issue": {
            "key": "PZ-1",
            "self": "https://acme.atlassian.net/rest/api/3/issue/10001",
            "fields": {"assignee": {"displayName": "Bob"}, "status": {"name": "Done"}},
        },
    }
    raw = json.dumps(payload).encode()
    secret = account_secret(jira_client, ws_id)
    sig = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    res = jira_client.post(
        "/api/webhooks/jira",
        content=raw,
        headers={"X-Hub-Signature-256": f"sha256={sig}", "Content-Type": "application/json"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 1

    task = jira_client.get(
        f"/sync/projects/{pid}/graph", headers={"X-User-Id": "alice"}
    ).json()["tasks"][0]
    assert task["assignee"] == "Bob"  # pmo field applied
    assert task["status"] == "in_progress"  # pz field untouched by the tracker


def test_webhook_rejects_forged_signature(jira_client, monkeypatch):
    _bootstrap(jira_client, monkeypatch)
    # A *recognized* site with a bad signature, so this stays a test of
    # signature verification rather than of account routing (which
    # tests/test_tracker_account_identity.py covers).
    payload = {
        "webhookEvent": "jira:issue_updated",
        "issue": {
            "key": "PZ-1",
            "self": "https://acme.atlassian.net/rest/api/3/issue/10001",
            "fields": {},
        },
    }
    raw = json.dumps(payload).encode()
    res = jira_client.post(
        "/api/webhooks/jira",
        content=raw,
        headers={"X-Hub-Signature-256": "sha256=forged", "Content-Type": "application/json"},
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_signature"


def test_providers_advertises_only_available_providers(jira_client):
    """Plan 0019 M4 / finding 14: ClickUp is registered but has no credential or
    account-identity path, so it must not be advertised as configurable."""
    body = jira_client.get("/integrations/providers").json()
    assert body["providers"] == ["jira"]


def test_configuring_an_unavailable_provider_is_refused(jira_client):
    ws = jira_client.post(
        "/workspaces", json={"name": "W"}, headers={"X-User-Id": "alice"}
    ).json()
    res = jira_client.post(
        f"/workspaces/{ws['id']}/integrations/clickup",
        json={"base_url": "https://api.clickup.com", "project_key": "list-9"},
        headers={"X-User-Id": "alice"},
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "provider_unavailable:clickup"
    # An unknown name is still a 404, so a typo and a known gap stay distinct.
    unknown = jira_client.post(
        f"/workspaces/{ws['id']}/integrations/linear",
        json={"base_url": "https://example.atlassian.net", "project_key": "PZ"},
        headers={"X-User-Id": "alice"},
    )
    assert unknown.status_code == 404
