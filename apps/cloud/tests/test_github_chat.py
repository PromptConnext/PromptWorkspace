"""Code retrieval in chat (M11): fetch-on-demand content, file/line
citations, and that content questions still work with no GitHub
integration configured at all — mirrors tests/test_rag_chat.py's style.
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.integrations.github import FakeGithubClient
from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}
REPO = "acme/rocket"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.github_client = FakeGithubClient()
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _parse_sse(body: str, event: str) -> dict | None:
    for block in body.split("\n\n"):
        lines = block.splitlines()
        is_match = any(line == f"event: {event}" for line in lines)
        if not is_match:
            continue
        data_line = next((line for line in lines if line.startswith("data:")), None)
        if data_line:
            return json.loads(data_line[len("data:") :].strip())
    return None


@pytest.fixture
def project_with_code(client: TestClient) -> tuple[str, str]:
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

    connected = client.put(
        f"/workspaces/{ws['id']}/integrations/github",
        json={"owner": REPO.split("/")[0], "token": "github_pat_test"},
        headers=ALICE,
    )
    assert connected.status_code == 200, connected.text

    repo = client.app.state.repository
    repo.upsert_code_chunks(
        ws["id"], project["id"], REPO, "src/login.ts", "sha-head", [(1, 3)], [[0.1] * 32]
    )
    client.app.state.github_client.set_file(
        REPO, "src/login.ts", "sha-head", "export function login() {\n  return true;\n}\n"
    )
    return ws["id"], project["id"]


def test_content_question_returns_code_citation_with_fetched_snippet(
    client: TestClient, project_with_code: tuple[str, str]
):
    _ws_id, pid = project_with_code
    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain how the login function works"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text

    citations = _parse_sse(res.text, "citations")["citations"]
    code_citations = [c for c in citations if c["source"] == "code"]
    assert code_citations, "expected at least one code citation"
    cite = code_citations[0]
    assert cite["repo"] == REPO
    assert cite["path"] == "src/login.ts"
    assert cite["start_line"] == 1
    assert cite["end_line"] == 3

    # The fetched snippet reached the model as context (FakeChatProvider
    # echoes the context it was given) but was never persisted anywhere.
    answer = "".join(
        json.loads(b[len("data:") :].strip())["delta"]
        for b in res.text.split("\n\n")
        if b.startswith("data:") and "delta" in b
    )
    assert "login" in answer


def test_content_question_works_with_no_github_integration_configured(client: TestClient):
    """A content question must still work when GitHub isn't configured —
    code_vector_search naturally returns nothing, and _fetch_code_context
    must not error just because there's no installation to mint a token
    from."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
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

    res = client.post(
        f"/projects/{project['id']}/assistant/chat",
        json={"question": "Explain the design"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    citations = _parse_sse(res.text, "citations")["citations"]
    assert not [c for c in citations if c["source"] == "code"]


def test_code_hits_from_other_workspace_are_unreachable(
    client: TestClient, project_with_code: tuple[str, str]
):
    """Membership-scoped-before-similarity (ADR 0011) applies to the code
    index too, not just the text index — repository-layer proof, same shape
    as test_rag_chat.py::test_vector_search_is_scoped_to_workspace_and_project."""
    ws_a_id, pid_a = project_with_code
    ws_b = client.post("/workspaces", json={"name": "W-B"}, headers=BOB).json()

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert len(repo.code_vector_search(ws_a_id, pid_a, zero_vector, top_k=10)) > 0
    assert repo.code_vector_search(ws_b["id"], pid_a, zero_vector, top_k=10) == []
