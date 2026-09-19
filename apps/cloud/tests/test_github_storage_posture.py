"""M11's own named exit criterion: "a dump of all PromptConnext-cloud storage
contains no source-code plaintext (embeddings + refs only) — verified by
test." This runs a full index (push webhook -> queue drain) + chat cycle
(which fetches the same file again, on demand, for answer context) against
a FakeGithubClient returning distinctive, easy-to-search-for fake source
text, then deep-scans every string reachable from the repository's own
state and asserts that text never landed anywhere.

Deliberately generic (walks the object graph, not a fixed list of known
fields) — the real risk this guards against is someone later adding a
`content` column to CodeChunk "for convenience"; a test that only checks
today's schema shape wouldn't catch that.
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
SECRET_MARKER = "sk-live-should-never-be-persisted-9f3c7a"
FILE_CONTENT = f"const apiKey = '{SECRET_MARKER}';\nexport function login() {{ return apiKey; }}\n"


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.github_client = FakeGithubClient()
        yield c


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _all_strings(obj, seen: set[int], acc: list[str]) -> None:
    """Depth-first walk collecting every string value reachable from `obj` —
    through dicts, lists/tuples/sets, and pydantic models (via model_dump)."""
    if id(obj) in seen:
        return
    tracked = isinstance(obj, dict | list | tuple | set) or hasattr(obj, "model_dump")
    if tracked or hasattr(obj, "__dict__"):
        seen.add(id(obj))
    if isinstance(obj, str):
        acc.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _all_strings(v, seen, acc)
    elif isinstance(obj, list | tuple | set):
        for v in obj:
            _all_strings(v, seen, acc)
    elif hasattr(obj, "model_dump"):
        _all_strings(obj.model_dump(mode="json"), seen, acc)
    elif hasattr(obj, "__dict__"):
        for v in vars(obj).values():
            _all_strings(v, seen, acc)


def test_no_source_code_plaintext_anywhere_in_storage_after_index_and_chat(client: TestClient):
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

    # Bind the repo to this project with its own webhook secret — what
    # create-repository does for real. Without it the delivery below is
    # unroutable and silently acked.
    repository = client.app.state.repository
    repository.upsert_repo_webhook(
        RepoWebhook(
            repo_full_name=REPO,
            project_id=project["id"],
            workspace_id=ws["id"],
            secret_ref=client.app.state.secret_store.encrypt(WEBHOOK_SECRET),
        )
    )
    repository.update_project_repo(project["id"], f"https://github.com/{REPO}", 1, "main")

    fake_github = client.app.state.github_client
    fake_github.set_file(REPO, "src/auth.ts", "sha-head", FILE_CONTENT)

    # 1. Full index: push webhook -> off-request-path queue -> embed + store.
    push_payload = {
        "ref": "refs/heads/main",
        "after": "sha-head",
        "commits": [{"added": ["src/auth.ts"], "modified": [], "removed": []}],
        "repository": {"full_name": REPO, "default_branch": "main"},
    }
    body = json.dumps(push_payload).encode()
    res = client.post(
        "/api/webhooks/github",
        content=body,
        headers={
            "content-type": "application/json",
            "x-github-event": "push",
            "x-hub-signature-256": _sign(body),
        },
    )
    assert res.status_code == 200

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(
        lambda: len(repo.code_vector_search(ws["id"], project["id"], zero_vector, top_k=10)) > 0
    ), "code chunks never finished indexing"

    # 2. Chat cycle: a content question triggers fetch-on-demand, re-fetching
    # the same file for answer context.
    chat_res = client.post(
        f"/projects/{project['id']}/assistant/chat",
        json={"question": "Explain the auth module"},
        headers=ALICE,
    )
    assert chat_res.status_code == 200, chat_res.text

    # Sanity: prove the fetch genuinely happened (else this test would pass
    # vacuously — nothing fetched, nothing to leak).
    assert fake_github.fetched_files, "no file was ever fetched — test would pass vacuously"
    assert SECRET_MARKER in FILE_CONTENT  # the fixture itself is meaningful

    # 3. The actual assertion: deep-scan every string reachable from the
    # repository's own state.
    strings: list[str] = []
    _all_strings(repo, set(), strings)
    offending = [s for s in strings if SECRET_MARKER in s]
    assert offending == [], f"source code leaked into storage: {offending!r}"
