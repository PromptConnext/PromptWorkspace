"""Jira comment mirroring (M12): comment_created/comment_updated webhooks
become pmo-sourced Discussion rows linked to the right task via the existing
TaskLink table — same signature-verification and fixture shape as
test_integrations.py's issue-update tests."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from tests._tracker import account_secret

JIRA_CONFIG = {"base_url": "https://acme.atlassian.net", "project_key": "PZ"}
# Every payload has to say which Jira site sent it (plan 0019 M2) — that is what
# selects the secret the signature is verified against.
JIRA_SITE_SELF = "https://acme.atlassian.net/rest/api/3/issue/10001"
ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def jira_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("JIRA_EMAIL", "bot@acme.com")
    monkeypatch.setenv("JIRA_API_TOKEN", "token-123")
    get_settings.cache_clear()
    app = create_app()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def _bootstrap(client: TestClient, monkeypatch) -> tuple[str, str]:
    """Create ws + project + task, configure Jira, and mirror the task (with
    a stubbed outbound call) so a TaskLink exists. Returns (workspace_id, project_id)."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    pid = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()["id"]
    client.put(
        f"/sync/projects/{pid}/graph",
        json={"tasks": [{"id": "t1", "project_id": pid, "title": "Login"}]},
        headers=ALICE,
    )
    cfg = client.post(
        f"/workspaces/{ws['id']}/integrations/jira", json=JIRA_CONFIG, headers=ALICE
    )
    assert cfg.status_code == 200, cfg.text

    import app.api.integrations as integ

    monkeypatch.setattr(integ, "_send", lambda outbound, auth: {"key": "PZ-1"})
    link = client.post(
        f"/projects/{pid}/tasks/t1/mirror", params={"provider": "jira"}, headers=ALICE
    )
    assert link.status_code == 200, link.text
    return ws["id"], pid


def _sign(secret: str, raw: bytes) -> str:
    return hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()


def _post_comment_webhook(client: TestClient, workspace_id: str, payload: dict):
    """Deliver a comment webhook as the configured Jira site would: the payload
    names the site, and the signature is that site's own secret."""
    payload = {**payload, "issue": {**payload.get("issue", {}), "self": JIRA_SITE_SELF}}
    raw = json.dumps(payload).encode()
    secret = account_secret(client, workspace_id)
    return client.post(
        "/api/webhooks/jira",
        content=raw,
        headers={
            "X-Hub-Signature-256": f"sha256={_sign(secret, raw)}",
            "Content-Type": "application/json",
        },
    )


def test_comment_created_becomes_pmo_discussion_linked_to_task(jira_client, monkeypatch):
    ws_id, pid = _bootstrap(jira_client, monkeypatch)
    payload = {
        "webhookEvent": "comment_created",
        "issue": {"key": "PZ-1"},
        "comment": {
            "id": "10001",
            "author": {"displayName": "Bob Reviewer"},
            "body": "This looks ready to ship.",
        },
    }
    res = _post_comment_webhook(jira_client, ws_id, payload)
    assert res.status_code == 200, res.text
    assert res.json()["applied"] == 1

    graph = jira_client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert len(graph["discussions"]) == 1
    discussion = graph["discussions"][0]
    assert discussion["parent_node_id"] == "t1"
    assert discussion["parent_node_type"] == "tasks"
    assert discussion["source"] == "pmo"
    assert discussion["author"] == "Bob Reviewer"
    assert discussion["body"] == "This looks ready to ship."


def test_comment_body_as_adf_extracts_plain_text(jira_client, monkeypatch):
    ws_id, pid = _bootstrap(jira_client, monkeypatch)
    payload = {
        "webhookEvent": "comment_created",
        "issue": {"key": "PZ-1"},
        "comment": {
            "id": "10002",
            "author": {"accountId": "abc123"},
            "body": {
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [
                            {"type": "text", "text": "Nice work "},
                            {"type": "text", "text": "on this."},
                        ],
                    }
                ],
            },
        },
    }
    res = _post_comment_webhook(jira_client, ws_id, payload)
    assert res.status_code == 200, res.text

    graph = jira_client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert "Nice work" in graph["discussions"][0]["body"]
    assert "on this." in graph["discussions"][0]["body"]


def test_comment_redelivery_is_idempotent(jira_client, monkeypatch):
    ws_id, pid = _bootstrap(jira_client, monkeypatch)
    payload = {
        "webhookEvent": "comment_created",
        "issue": {"key": "PZ-1"},
        "comment": {"id": "10003", "author": {"displayName": "Bob"}, "body": "First delivery"},
    }
    assert _post_comment_webhook(jira_client, ws_id, payload).status_code == 200
    # Redelivered (or a comment_updated for the same id) — same comment_id.
    payload["webhookEvent"] = "comment_updated"
    payload["comment"]["body"] = "First delivery, edited"
    assert _post_comment_webhook(jira_client, ws_id, payload).status_code == 200

    graph = jira_client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert len(graph["discussions"]) == 1
    assert graph["discussions"][0]["body"] == "First delivery, edited"


def test_comment_for_unlinked_issue_is_ignored(jira_client, monkeypatch):
    ws_id, pid = _bootstrap(jira_client, monkeypatch)
    payload = {
        "webhookEvent": "comment_created",
        "issue": {"key": "PZ-999"},  # no TaskLink for this key
        "comment": {"id": "10004", "author": {"displayName": "Bob"}, "body": "orphan comment"},
    }
    res = _post_comment_webhook(jira_client, ws_id, payload)
    assert res.status_code == 200
    assert res.json()["applied"] == 0

    graph = jira_client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert graph["discussions"] == []


def test_comment_webhook_rejects_forged_signature(jira_client, monkeypatch):
    _bootstrap(jira_client, monkeypatch)
    # Site is recognized (so routing succeeds); only the signature is wrong.
    payload = {
        "webhookEvent": "comment_created",
        "issue": {"key": "PZ-1", "self": JIRA_SITE_SELF},
        "comment": {"id": "10005", "author": {}, "body": "x"},
    }
    raw = json.dumps(payload).encode()
    res = jira_client.post(
        "/api/webhooks/jira",
        content=raw,
        headers={"X-Hub-Signature-256": "sha256=deadbeef", "Content-Type": "application/json"},
    )
    assert res.status_code == 401


def test_mirrored_comment_is_cross_tenant_isolated(jira_client, monkeypatch):
    """RLS-equivalent boundary at the repository layer (memory backend) —
    same pattern as every other RAG/graph cross-tenant test this session."""
    ws_id, pid = _bootstrap(jira_client, monkeypatch)
    _post_comment_webhook(
        jira_client,
        ws_id,
        {
            "webhookEvent": "comment_created",
            "issue": {"key": "PZ-1"},
            "comment": {
                "id": "10006",
                "author": {"displayName": "Bob"},
                "body": "visible to alice only",
            },
        },
    )
    jira_client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)
    res = jira_client.get(f"/sync/projects/{pid}/graph", headers=BOB)
    assert res.status_code == 403
