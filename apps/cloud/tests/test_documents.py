"""Project knowledge base: upload -> extract -> embed (M0, plan 0007).

Exit criteria under test: a markdown upload produces chunks in
pz_rag_chunks-equivalent (vector_search) for that project; a born-digital PDF
extracts via the text layer (OCR never called); a scanned/image-only PDF
falls back to the stubbed OCR provider; a non-member is 403; an oversize or
unsupported-type upload is 413/415; another workspace provably cannot
retrieve the chunks (RLS-equivalent boundary at the repository layer, same
pattern as every other RAG/graph cross-tenant test this session).
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.documents.ocr import FakeOcrProvider
from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.ocr_provider = FakeOcrProvider()
        yield c


def _wait_until(predicate, timeout: float = 2.0, interval: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def _bootstrap(client: TestClient) -> tuple[str, str]:
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
    return ws["id"], project["id"]


def _chunk_count(client: TestClient, ws_id: str, pid: str) -> int:
    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    return len(repo.vector_search(ws_id, pid, zero_vector, top_k=100))


def _make_pdf(content_stream: bytes) -> bytes:
    """Hand-built minimal single-page PDF — no external PDF-writer dependency
    needed just to exercise the text-layer/OCR-fallback branch."""
    objects = [
        b"1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj",
        b"2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj",
        b"3 0 obj<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> "
        b"/MediaBox [0 0 612 792] /Contents 5 0 R >>endobj",
        b"4 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj",
        b"5 0 obj<< /Length %d >>stream\n%s\nendstream endobj"
        % (len(content_stream), content_stream),
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for obj in objects:
        offsets.append(len(pdf))
        pdf += obj + b"\n"
    xref_offset = len(pdf)
    pdf += b"xref\n0 %d\n" % (len(objects) + 1)
    pdf += b"0000000000 65535 f \n"
    for off in offsets:
        pdf += f"{off:010d} 00000 n \n".encode()
    pdf += b"trailer<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1)
    pdf += b"startxref\n" + str(xref_offset).encode() + b"\n%%EOF"
    return pdf


BORN_DIGITAL_PDF = _make_pdf(
    b"BT /F1 12 Tf 72 712 Td (This born-digital PRD covers the Thai payments rollout.) Tj ET"
)
SCANNED_PDF = _make_pdf(b"")  # no text operators -> empty text layer, like a scanned page


def test_markdown_upload_produces_rag_chunks(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", b"# Payments PRD\n\nSupport Thai QR payments.", "text/markdown")},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["status"] == "extracted"
    assert body["extract_method"] == "passthrough"

    assert _wait_until(lambda: _chunk_count(client, ws_id, pid) > 0), "chunks never appeared"


def test_born_digital_pdf_uses_text_layer_not_ocr(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    ocr = client.app.state.ocr_provider

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.pdf", BORN_DIGITAL_PDF, "application/pdf")},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["extract_method"] == "text_layer"
    assert ocr.calls == 0


def test_scanned_pdf_falls_back_to_ocr(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    ocr = client.app.state.ocr_provider

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("scan.pdf", SCANNED_PDF, "application/pdf")},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["extract_method"] == "ocr"
    assert ocr.calls == 1


def test_non_member_cannot_upload(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", b"secret roadmap", "text/markdown")},
        headers=BOB,
    )
    assert res.status_code == 403


def test_unsupported_media_type_is_415(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("virus.exe", b"MZ\x00\x00", "application/octet-stream")},
        headers=ALICE,
    )
    assert res.status_code == 415


def test_oversize_upload_is_413(client: TestClient, monkeypatch):
    _ws_id, pid = _bootstrap(client)
    monkeypatch.setattr("app.api.documents.MAX_DOCUMENT_BYTES", 10)

    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", b"this document is definitely over ten bytes", "text/markdown")},
        headers=ALICE,
    )
    assert res.status_code == 413


def test_document_content_streams_raw_bytes(client: TestClient):
    """The Planner previews the uploaded PRD itself, so the endpoint must hand
    back the stored bytes verbatim with the original mime — not extracted text."""
    _ws_id, pid = _bootstrap(client)
    raw = b"# Payments PRD\n\nSupport Thai QR payments."
    doc = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", raw, "text/markdown")},
        headers=ALICE,
    ).json()

    res = client.get(f"/projects/{pid}/documents/{doc['id']}/content", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.content == raw
    assert res.headers["content-type"].startswith("text/markdown")
    assert res.headers["x-content-type-options"] == "nosniff"
    assert "inline" in res.headers["content-disposition"]


def test_pdf_content_round_trips(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    doc = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.pdf", BORN_DIGITAL_PDF, "application/pdf")},
        headers=ALICE,
    ).json()

    res = client.get(f"/projects/{pid}/documents/{doc['id']}/content", headers=ALICE)
    assert res.status_code == 200
    assert res.content == BORN_DIGITAL_PDF
    assert res.headers["content-type"].startswith("application/pdf")


def test_non_member_cannot_read_document_content(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    doc = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", b"secret roadmap", "text/markdown")},
        headers=ALICE,
    ).json()

    res = client.get(f"/projects/{pid}/documents/{doc['id']}/content", headers=BOB)
    assert res.status_code == 403


def test_unknown_document_content_is_404(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    res = client.get(f"/projects/{pid}/documents/does-not-exist/content", headers=ALICE)
    assert res.status_code == 404


def test_missing_stored_bytes_is_404(client: TestClient):
    """The row can outlive the object (memory store restart, object deleted out
    of band) — that's a 404, not a 500."""
    _ws_id, pid = _bootstrap(client)
    doc = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", b"# PRD", "text/markdown")},
        headers=ALICE,
    ).json()
    client.app.state.document_store._files.clear()

    res = client.get(f"/projects/{pid}/documents/{doc['id']}/content", headers=ALICE)
    assert res.status_code == 404
    assert res.json()["detail"] == "document_content_missing"


def test_cross_workspace_cannot_retrieve_chunks(client: TestClient):
    """RLS-equivalent boundary at the repository layer (memory backend) —
    same pattern as every other RAG/graph cross-tenant test this session."""
    ws_id, pid = _bootstrap(client)
    confidential = b"# Confidential\n\nOnly alice's workspace should see this."
    res = client.post(
        f"/projects/{pid}/documents",
        files={"file": ("prd.md", confidential, "text/markdown")},
        headers=ALICE,
    )
    assert res.status_code == 201, res.text
    assert _wait_until(lambda: _chunk_count(client, ws_id, pid) > 0)

    other_ws = client.post("/workspaces", json={"name": "Bob's W"}, headers=BOB).json()
    other_project = client.post(
        "/projects", json={"name": "Other", "workspace_id": other_ws["id"]}, headers=BOB
    ).json()

    repo = client.app.state.repository
    zero_vector = [0.0] * FakeEmbeddingProvider.dim
    leaked = repo.vector_search(other_ws["id"], other_project["id"], zero_vector, top_k=100)
    assert leaked == []
