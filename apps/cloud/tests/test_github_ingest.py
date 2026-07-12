"""GitHub webhook ingestion (M11): signature verification, T-ref task
linkage for PRs, and push-driven code (re)indexing — mirrors
tests/test_rag_ingest.py's style for the embed-on-ingest pipeline.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
WEBHOOK_SECRET = "whsec_test"
REPO = "acme/rocket"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.github_client = FakeGithubClient()
        c.app.state.settings.github_webhook_secret = WEBHOOK_SECRET
        c.app.state.settings.github_app_id = "app-1"
        c.app.state.settings.github_app_private_key = "unused-by-fake-client"
        yield c


def _sign(body: bytes, secret: str = WEBHOOK_SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _post_webhook(client: TestClient, event: str, payload: dict, secret: str = WEBHOOK_SECRET):
    body = json.dumps(payload).encode()
    return client.post(
        "/api/webhooks/github",
        content=body,
        headers={
            "content-type": "application/json",
            "x-github-event": event,
            "x-hub-signature-256": _sign(body, secret),
        },
    )


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


@pytest.fixture
def workspace_project_task(client: TestClient) -> tuple[str, str, str]:
    ws = client.post("/workspaces", json={"name": "Acme"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "Rocket", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    conn = client.post(
        f"/workspaces/{ws['id']}/model-connection",
        json={
            "provider": "openai",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-x",
            "embed_model": "embed-x",
            "api_key": "sk-test",
        },
        headers=ALICE,
    )
    assert conn.status_code == 200, conn.text

    push = client.put(
        f"/sync/projects/{project['id']}/graph",
        json={
            "requirements": [{"id": "r1", "project_id": project["id"], "title": "Payments"}],
            "spec_documents": [
                {"id": "s1", "project_id": project["id"], "requirement_id": "r1", "content": "spec"}
            ],
            "tasks": [
                {
                    "id": "t1",
                    "project_id": project["id"],
                    "spec_id": "s1",
                    "title": "Build login form",
                    "feature_tag": "T001",
                }
            ],
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text

    install = client.post(
        f"/workspaces/{ws['id']}/integrations/github/install",
        json={
            "installation_id": "inst-1",
            "repo": REPO,
            "default_branch": "main",
            "project_id": project["id"],
        },
        headers=ALICE,
    )
    assert install.status_code == 200, install.text
    return ws["id"], project["id"], "t1"


def test_webhook_rejects_invalid_signature(client: TestClient):
    res = _post_webhook(client, "ping", {"zen": "hi"}, secret="wrong-secret")
    assert res.status_code == 401


def test_webhook_ping_is_acked_without_processing(client: TestClient):
    res = _post_webhook(client, "ping", {"zen": "hi"})
    assert res.status_code == 200
    assert res.json() == {"received": True}


def test_pull_request_links_task_via_tref_and_creates_artifact(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    ws_id, pid, task_id = workspace_project_task
    payload = {
        "action": "opened",
        "pull_request": {
            "number": 42,
            "title": "T001: add login form",
            "body": "Implements the login form.",
            "html_url": "https://github.com/acme/rocket/pull/42",
            "merged": False,
            "head": {"sha": "abc123"},
        },
        "repository": {"full_name": REPO},
    }
    res = _post_webhook(client, "pull_request", payload)
    assert res.status_code == 200
    assert res.json()["matched"] is True

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    prs = [a for a in graph["artifacts"] if a["kind"] == "pr"]
    assert len(prs) == 1
    assert prs[0]["task_id"] == task_id
    assert prs[0]["uri"] == "https://github.com/acme/rocket/pull/42"

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(lambda: len(repo.vector_search(ws_id, pid, zero_vector, top_k=10)) > 0)
    hits = repo.vector_search(ws_id, pid, zero_vector, top_k=10)
    assert any(h.node_type == "pull_requests" for h in hits)


def test_pull_request_without_task_ref_is_skipped(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    _ws_id, pid, _task_id = workspace_project_task
    payload = {
        "action": "opened",
        "pull_request": {
            "number": 43,
            "title": "Unrelated cleanup",
            "body": "No task reference here.",
            "html_url": "https://github.com/acme/rocket/pull/43",
            "merged": False,
            "head": {"sha": "def456"},
        },
        "repository": {"full_name": REPO},
    }
    res = _post_webhook(client, "pull_request", payload)
    assert res.status_code == 200

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    assert not [a for a in graph["artifacts"] if a["kind"] == "pr"]


def test_push_to_default_branch_indexes_changed_files(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    ws_id, pid, _task_id = workspace_project_task
    client.app.state.github_client.set_file(
        REPO, "src/login.ts", "sha-head", "export function login() {\n  return true;\n}\n"
    )
    payload = {
        "ref": "refs/heads/main",
        "after": "sha-head",
        "commits": [{"added": ["src/login.ts"], "modified": [], "removed": []}],
        "repository": {"full_name": REPO, "default_branch": "main"},
    }
    res = _post_webhook(client, "push", payload)
    assert res.status_code == 200

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(lambda: len(repo.code_vector_search(ws_id, pid, zero_vector, top_k=10)) > 0)
    hits = repo.code_vector_search(ws_id, pid, zero_vector, top_k=10)
    assert all(h.path == "src/login.ts" for h in hits)
    assert all(h.repo == REPO for h in hits)


def test_push_to_non_default_branch_is_ignored(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    ws_id, pid, _task_id = workspace_project_task
    payload = {
        "ref": "refs/heads/feature-x",
        "after": "sha-feature",
        "commits": [{"added": ["src/scratch.ts"], "modified": [], "removed": []}],
        "repository": {"full_name": REPO, "default_branch": "main"},
    }
    res = _post_webhook(client, "push", payload)
    assert res.status_code == 200

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    time.sleep(0.1)
    assert repo.code_vector_search(ws_id, pid, zero_vector, top_k=10) == []


def test_push_removing_a_file_deletes_its_code_chunks(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    ws_id, pid, _task_id = workspace_project_task
    repo = client.app.state.repository
    repo.upsert_code_chunks(ws_id, pid, REPO, "src/old.ts", "sha-old", [(1, 10)], [[0.1] * 32])

    payload = {
        "ref": "refs/heads/main",
        "after": "sha-head",
        "commits": [{"added": [], "modified": [], "removed": ["src/old.ts"]}],
        "repository": {"full_name": REPO, "default_branch": "main"},
    }
    res = _post_webhook(client, "push", payload)
    assert res.status_code == 200

    zero_vector = [0.0] * 32
    assert repo.code_vector_search(ws_id, pid, zero_vector, top_k=10) == []
