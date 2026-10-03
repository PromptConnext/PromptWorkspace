"""RAG assistant v1 chat (M9) — the milestone's exit criteria:

  1. A member asks a question and gets a correct, cited answer using only
     their workspace's model key.
  2. A member of another workspace provably cannot retrieve those chunks —
     tested at the repository layer (the structural equivalent of RLS for the
     in-memory backend; Postgres RLS itself is added in
     migrations/0002_pw_baseline.sql, section 0009_rag.sql
     and, per this repo's convention, verified by running against a real
     Supabase instance rather than in pytest — see README's migrations note).
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app.api.assistant import _assemble_context, _node_display_label
from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.main import create_app
from app.models.schemas import Document, ModelConnection, RagChunkHit
from app.rag.chat import SYSTEM_PROMPT, FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _setup_workspace_with_requirement(client: TestClient, user_headers: dict, req_id: str):
    ws = client.post("/workspaces", json={"name": "W"}, headers=user_headers).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=user_headers
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
        headers=user_headers,
    )
    assert conn.status_code == 200, conn.text
    push = client.put(
        f"/sync/projects/{project['id']}/graph",
        json={
            "requirements": [
                {
                    "id": req_id,
                    "project_id": project["id"],
                    "title": "Payments requirement",
                    "description": "Acceptance: supports one-time and subscription charges.",
                }
            ]
        },
        headers=user_headers,
    )
    assert push.status_code == 200, push.text

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert _wait_until(
        lambda: len(repo.vector_search(ws["id"], project["id"], zero_vector, top_k=10)) > 0
    )
    return ws["id"], project["id"]


def _managed_chat_connection(daily_token_budget: int = 20_000) -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="typhoon",
        base_url="https://api.opentyphoon.ai/v1",
        model="typhoon-v2.5-30b-a3b-instruct",
        embed_model="",
        embed_dim=0,
        secret_ref="unused-in-these-tests",
        daily_token_budget=daily_token_budget,
        created_by="platform",
        source="managed",
    )


def _managed_embed_connection(embed_model: str = "bge-m3") -> ModelConnection:
    return ModelConnection(
        workspace_id=MANAGED_WORKSPACE_MARKER,
        provider="platform-embed",
        base_url="https://embed.internal/v1",
        model="",
        embed_model=embed_model,
        embed_dim=1536,
        secret_ref="unused-in-these-tests",
        daily_token_budget=20_000,
        created_by="platform",
        source="managed",
    )


def _setup_keyless_workspace(client: TestClient) -> tuple[str, str]:
    """A workspace with no BYO model connection at all — the caller wires up
    `app.state.managed_connection` / `managed_embed_connection` as needed."""
    ws = client.post("/workspaces", json={"name": "Keyless W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def _setup_workspace_with_model_only(client: TestClient, user_headers: dict) -> tuple[str, str]:
    """A workspace with a real BYO model connection (so embeddings are
    available) but no graph content pushed — so the vector index stays
    empty."""
    ws = client.post("/workspaces", json={"name": "W"}, headers=user_headers).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=user_headers
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
        headers=user_headers,
    )
    assert conn.status_code == 200, conn.text
    return ws["id"], project["id"]


def _parse_sse_citations(body: str) -> list[dict]:
    for block in body.split("\n\n"):
        if block.startswith("event: citations"):
            data_line = next(line for line in block.splitlines() if line.startswith("data:"))
            return json.loads(data_line[len("data:") :].strip())["citations"]
    raise AssertionError(f"no citations event in SSE body: {body!r}")


def _parse_sse_retrieval(body: str) -> dict | None:
    for block in body.split("\n\n"):
        if block.startswith("event: retrieval"):
            data_line = next(line for line in block.splitlines() if line.startswith("data:"))
            return json.loads(data_line[len("data:") :].strip())
    return None


def _parse_sse_answer(body: str) -> str:
    deltas = []
    for block in body.split("\n\n"):
        if block.startswith("data:") and "delta" in block:
            deltas.append(json.loads(block[len("data:") :].strip())["delta"])
    return "".join(deltas)


def test_chat_returns_answer_grounded_with_citations(client: TestClient):
    ws_id, pid = _setup_workspace_with_requirement(client, ALICE, "r1")

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What are the payments acceptance criteria?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    answer = _parse_sse_answer(res.text)
    assert "Based on the context" in answer  # FakeChatProvider's grounded answer
    assert "requirements:r1" in answer  # the retrieved chunk's citation marker

    citations = _parse_sse_citations(res.text)
    assert citations, "expected at least one citation"
    assert citations[0]["node_type"] == "requirements"
    assert citations[0]["node_id"] == "r1"


def test_chat_requires_model_connection(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    res = client.post(
        f"/projects/{project['id']}/assistant/chat",
        json={"question": "anything"},
        headers=ALICE,
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "model_connection_not_configured"


def test_other_workspace_member_cannot_reach_project(client: TestClient):
    _ws_a, pid_a = _setup_workspace_with_requirement(client, ALICE, "r1")
    # bob is a member of a different workspace entirely.
    client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB)

    res = client.post(
        f"/projects/{pid_a}/assistant/chat", json={"question": "x"}, headers=BOB
    )
    assert res.status_code == 403


def test_vector_search_is_scoped_to_workspace_and_project(client: TestClient):
    """Repository-layer proof: even given workspace A's own project_id, a
    query scoped to workspace B's workspace_id retrieves nothing — the
    explicit predicate (ADR 0011) rejects a workspace_id/project_id mismatch
    outright, before any similarity ranking runs."""
    ws_a_id, pid_a = _setup_workspace_with_requirement(client, ALICE, "r1")
    ws_b = client.post("/workspaces", json={"name": "W-B"}, headers=BOB).json()

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    assert len(repo.vector_search(ws_a_id, pid_a, zero_vector, top_k=10)) > 0
    assert repo.vector_search(ws_b["id"], pid_a, zero_vector, top_k=10) == []


# Task 10: retrieval transparency — the `retrieval` SSE frame that tells the
# client apart a content answer that was never grounded (no embedding model
# configured) from one whose corpus is genuinely empty, and confirms the
# frame stays silent everywhere else (real hits, a lineage-only question, or
# a budget-exhausted response that already explains itself).


def test_retrieval_gap_emitted_when_no_embed_model(client: TestClient):
    ws_id, pid = _setup_keyless_workspace(client)
    client.app.state.managed_connection = _managed_chat_connection()
    # Real MemorySecretStore.decrypt() would choke on the placeholder
    # secret_ref above — this test only cares that the resolved connection
    # is used, not real ciphertext round-tripping (matches
    # test_assistant_keyless.py's fixture pattern).
    client.app.state.secret_store.decrypt = lambda _ref: "platform-key"
    # managed_embed_connection is left at its default (None) — the
    # workspace has a chat model but no separate embedding model.
    assert client.app.state.managed_embed_connection is None

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain the payments architecture"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    retrieval = _parse_sse_retrieval(res.text)
    assert retrieval == {"grounded": False, "reason": "no_embed_model"}


def test_retrieval_gap_emitted_when_no_indexed_content(client: TestClient):
    # A real BYO connection (so embed is resolved), but nothing was ever
    # pushed into the project's graph — the vector index stays empty.
    _ws_id, pid = _setup_workspace_with_model_only(client, ALICE)

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "Explain the payments architecture"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    retrieval = _parse_sse_retrieval(res.text)
    assert retrieval == {"grounded": False, "reason": "no_indexed_content"}


def test_retrieval_frame_absent_when_hits_exist(client: TestClient):
    _ws_id, pid = _setup_workspace_with_requirement(client, ALICE, "r1")

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What are the payments acceptance criteria?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert _parse_sse_citations(res.text), "expected retrieval to actually find something"
    assert _parse_sse_retrieval(res.text) is None


def test_retrieval_frame_absent_for_lineage_only_question(client: TestClient):
    ws_id, pid = _setup_keyless_workspace(client)
    client.app.state.managed_connection = _managed_chat_connection()
    client.app.state.secret_store.decrypt = lambda _ref: "platform-key"
    # No embed model at all — if the classification gate were missing this
    # would otherwise trip `no_embed_model`, so a silent frame here proves
    # the lineage branch is skipped before that check even runs.
    assert client.app.state.managed_embed_connection is None

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        json={"question": "What's the status of this project?"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert "event: facts" in res.text
    assert _parse_sse_retrieval(res.text) is None


def test_retrieval_frame_absent_when_budget_exhausted(client: TestClient):
    ws_id, pid = _setup_keyless_workspace(client)
    client.app.state.managed_connection = _managed_chat_connection(daily_token_budget=0)
    client.app.state.secret_store.decrypt = lambda _ref: "platform-key"
    # managed_embed_connection stays None — would also trip `no_embed_model`
    # if the budget-exhausted guard were missing.
    assert client.app.state.managed_embed_connection is None

    res = client.post(
        f"/projects/{pid}/assistant/chat",
        # "explain" (content) + "status" (lineage) -> "mixed", so facts are
        # computed and the request soft-degrades (200) instead of 429ing.
        json={"question": "Explain the status of this project"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    assert "budget reached" in res.text.lower()
    assert _parse_sse_retrieval(res.text) is None


# Task 9 (grounding fix): context labels must state what a retrieved artifact
# actually IS, not just a bare `node_type:uuid` pair. The live defect this
# fixes: a `spec_documents:8f3a12b4-...` chunk (a specification *generated
# from* a PRD during planning) gave the model nothing to tell it apart from
# the uploaded PRD it was asked to summarize, so the model narrated as though
# it had read the PRD when only the derived spec was ever retrieved.


def test_node_display_label_is_self_describing_per_type():
    """Pure dispatch on node_type (+ a cheap attribute already on the fetched
    node) — never on question text. Covers every RAG_NODE_TYPES member plus
    the "node not found" fallback."""

    class _Node:
        def __init__(self, **kw):
            self.__dict__.update(kw)

    # Uploaded document and requirement: title is cheaply available on the
    # node, and leads the label.
    assert _node_display_label("documents", _Node(title="Make Story Time 2.0 PRD")) == (
        'Uploaded source document: "Make Story Time 2.0 PRD"'
    )
    assert _node_display_label("requirements", _Node(title="Payments requirement")) == (
        'Requirement: "Payments requirement"'
    )

    # spec_documents has no title field at all (SpecDocument carries only
    # body content) — the label says what it IS in words instead, and
    # explicitly disclaims it as the original document. This is the exact
    # case that fooled the model in the live defect.
    spec_label = _node_display_label("spec_documents", _Node(content="body"))
    assert "Generated specification" in spec_label
    assert "not an uploaded document" in spec_label

    assert _node_display_label("tasks", _Node(title="Wire up billing")) == (
        'Task: "Wire up billing"'
    )

    # stage_documents: which planning stage is the human-meaningful
    # identifier here (there's no title field), and must be named.
    stage_label = _node_display_label("stage_documents", _Node(stage="plan"))
    assert '"plan" stage' in stage_label
    assert "generated, not uploaded" in stage_label

    assert _node_display_label("pull_requests", _Node(title="Add retry logic")) == (
        'Pull request: "Add retry logic"'
    )
    assert _node_display_label("discussions", _Node(author="alice")) == (
        "Discussion comment by alice"
    )

    # Missing attribute (e.g. the node itself couldn't be resolved) still
    # produces a self-describing label, never a crash or a bare identifier.
    assert _node_display_label("requirements", None) == "Requirement"
    assert _node_display_label("spec_documents", None) == spec_label


def test_assemble_context_distinguishes_uploaded_from_generated_artifacts(client: TestClient):
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    push = client.put(
        f"/sync/projects/{pid}/graph",
        json={
            "requirements": [
                {
                    "id": "r1",
                    "project_id": pid,
                    "title": "Payments requirement",
                    "description": "Acceptance: supports one-time charges.",
                }
            ],
            "spec_documents": [
                {
                    "id": "s1",
                    "project_id": pid,
                    "requirement_id": "r1",
                    "content": "Generated spec body describing the payments flow.",
                }
            ],
        },
        headers=ALICE,
    )
    assert push.status_code == 200, push.text

    repo = client.app.state.repository
    doc = repo.create_document(
        Document(
            id="doc1",
            workspace_id=ws["id"],
            project_id=pid,
            title="Make Story Time 2.0 PRD",
            mime="application/pdf",
            storage_ref="fake://doc1",
            created_by="alice",
            extracted_text="The PRD's own text.",
        )
    )
    stage_doc = repo.upsert_stage_document(pid, ws["id"], "plan", "Plan body content", "alice")

    hits = [
        RagChunkHit(
            node_type="requirements", node_id="r1", chunk_index=0,
            content="Payments requirement\n\nAcceptance: supports one-time charges.",
            score=0.9,
        ),
        RagChunkHit(
            node_type="spec_documents", node_id="s1", chunk_index=0,
            content="Generated spec body describing the payments flow.", score=0.8,
        ),
        RagChunkHit(
            node_type="documents", node_id=doc.id, chunk_index=0,
            content="The PRD's own text.", score=0.7,
        ),
        RagChunkHit(
            node_type="stage_documents", node_id=stage_doc.id, chunk_index=0,
            content="Plan body content", score=0.6,
        ),
    ]

    context = _assemble_context(repo, pid, None, hits, [])

    # Each artifact type reads distinguishably, and none of them collapse to
    # the old bare `[node_type:uuid#index]` label.
    assert 'Requirement: "Payments requirement"' in context
    assert "requirements:r1#0" in context
    assert "[requirements:r1#0]" not in context  # the old, non-descriptive form

    assert "Generated specification" in context
    assert "not an uploaded document" in context
    assert "spec_documents:s1#0" in context
    assert "[spec_documents:s1#0]" not in context

    assert 'Uploaded source document: "Make Story Time 2.0 PRD"' in context
    assert f"documents:{doc.id}#0" in context

    assert '"plan" stage' in context
    assert f"stage_documents:{stage_doc.id}#0" in context

    # The uploaded document and the generated specification are clearly not
    # the same kind of thing in the assembled text — the exact distinction
    # the model needs to avoid claiming it read the PRD when it only
    # retrieved a derived artifact.
    assert "Uploaded source document" in context
    assert context.index("Uploaded source document") != context.index("Generated specification")


def test_system_prompt_instructs_honest_attribution():
    """Code-level proof only: the instruction text is present. Whether a
    live model actually follows it is NOT something this test can verify —
    that requires a real model call (see the task report)."""
    assert "labeled with what it actually is" in SYSTEM_PROMPT
    assert "questioner's framing" in SYSTEM_PROMPT
    assert "derived artifact" in SYSTEM_PROMPT
    assert "not that original document" in SYSTEM_PROMPT
