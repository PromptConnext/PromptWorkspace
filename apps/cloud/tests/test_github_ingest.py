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
from app.models.schemas import RepoWebhook
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
        yield c


def _connect_github(client: TestClient, workspace_id: str, owner: str = "acme") -> None:
    """Workspace-level credential (a fine-grained PAT), verified by the fake
    client rather than GitHub."""
    res = client.put(
        f"/workspaces/{workspace_id}/integrations/github",
        json={"owner": owner, "token": "github_pat_test"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text


def _bind_repo(
    client: TestClient, workspace_id: str, project_id: str, secret: str = WEBHOOK_SECRET
) -> None:
    """Stand in for what `POST /projects/{id}/lifecycle/create-repository`
    writes when it registers the repo's webhook — these tests exercise
    ingestion, not repo creation."""
    repository = client.app.state.repository
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project_id,
            workspace_id=workspace_id,
            secret_ref=client.app.state.secret_store.encrypt(secret),
        )
    )


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

    _connect_github(client, ws["id"])
    _bind_repo(client, ws["id"], project["id"])
    # The push handler reads the branch off the project, not workspace config.
    client.app.state.repository.update_project_repo(
        project["id"], f"https://github.com/{REPO}", 1, "main"
    )
    return ws["id"], project["id"], "t1"


def test_webhook_rejects_invalid_signature(client: TestClient, workspace_project_task):
    res = _post_webhook(
        client, "ping", {"zen": "hi", "repository": {"full_name": REPO}}, secret="wrong-secret"
    )
    assert res.status_code == 401


def test_webhook_ping_is_acked_without_processing(client: TestClient, workspace_project_task):
    res = _post_webhook(client, "ping", {"zen": "hi", "repository": {"full_name": REPO}})
    assert res.status_code == 200
    assert res.json() == {"received": True}


def test_webhook_for_unknown_repo_is_acked_not_processed(client: TestClient):
    # No binding exists, so there is no secret to verify against. Ack rather
    # than 401 so GitHub stops retrying a hook we no longer own.
    res = _post_webhook(client, "push", {"repository": {"full_name": "stranger/repo"}})
    assert res.status_code == 200
    assert res.json() == {"received": True, "matched": False}


def test_webhook_secret_is_per_repo_not_shared(client: TestClient, workspace_project_task):
    # A second project's repo gets its own secret; the first repo's secret
    # must not validate a delivery for the second.
    ws_id, project_id, _ = workspace_project_task
    other = "acme/other"
    client.app.state.repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=other,
            project_id=project_id,
            workspace_id=ws_id,
            secret_ref=client.app.state.secret_store.encrypt("whsec_other"),
        )
    )
    body = json.dumps({"zen": "hi", "repository": {"full_name": other}}).encode()
    res = client.post(
        "/api/webhooks/github",
        content=body,
        headers={
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": _sign(body, WEBHOOK_SECRET),
        },
    )
    assert res.status_code == 401


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


def test_a_two_digit_task_ref_now_links_a_pull_request(
    client: TestClient, workspace_project_task: tuple[str, str, str]
):
    """The defect ADR 0023 names: the editor closed T1 and the server linked
    nothing, because "T001".split(" ")[0] never equalled "T1" — and the old
    \\bT\\d{3}\\b could not even see a two-digit ref."""
    _ws_id, pid, task_id = workspace_project_task
    payload = {
        "action": "opened",
        "pull_request": {
            "number": 7,
            "title": "feat: add a retry T1",
            "body": "",
            "html_url": "https://github.com/acme/rocket/pull/7",
            "merged": False,
            "head": {"sha": "deadbeef"},
        },
        "repository": {"full_name": REPO},
    }
    assert _post_webhook(client, "pull_request", payload).status_code == 200

    graph = client.get(f"/sync/projects/{pid}/graph", headers=ALICE).json()
    prs = [a for a in graph["artifacts"] if a["kind"] == "pr"]
    assert [a["task_id"] for a in prs] == [task_id]
