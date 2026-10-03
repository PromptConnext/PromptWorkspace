"""Project knowledge base: artifact upload -> extract -> embed (M0, plan 0007).

A member uploads a PRD (PDF/Markdown/plain text); it's stored raw (Supabase
Storage in prod, in-memory for tests), extracted to text (text-layer first,
`typhoon-ocr` fallback stubbed behind a provider interface — app/documents/
ocr.py), and enqueued onto the same embed-on-ingest queue every other node
type uses (app/rag/queue.py) so `specify`/`plan` can ground on it later
(M1). Extraction failure doesn't fail the upload — the document still exists
so a member can see *why* it failed, mirroring how a missing model
connection skips embedding rather than erroring the caller (app/rag/queue.py).
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi import File as FastAPIFile

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.documents.extract import ALLOWED_MIMES, UnsupportedMimeError, extract_text
from app.documents.ocr import StubOcrProvider
from app.documents.sources import UploadSource
from app.documents.storage import DocumentNotStored
from app.models.schemas import Document, DocumentOut, DocumentStatus
from app.rag.queue import EmbedJob, enqueue

logger = logging.getLogger("promptworkspace.documents")
router = APIRouter(tags=["documents"])

# Enforced server-side regardless of what a client claims — matches the
# plan's "size/type caps enforced server-side."
MAX_DOCUMENT_BYTES = 10_000_000


@router.post("/projects/{project_id}/documents", response_model=DocumentOut, status_code=201)
async def upload_document(
    project_id: str,
    request: Request,
    file: UploadFile = FastAPIFile(...),
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> DocumentOut:
    project = require_project(repo, project_id, user)

    mime = file.content_type or ""
    if mime not in ALLOWED_MIMES:
        raise HTTPException(status_code=415, detail="unsupported_media_type")

    content = await file.read()
    if len(content) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="document_too_large")

    source = UploadSource(content=content, mime=mime)
    fetched = await source.fetch()

    document_store = request.app.state.document_store
    document = Document(
        workspace_id=project.workspace_id,
        project_id=project_id,
        title=file.filename or "untitled",
        mime=mime,
        storage_ref="",
        source_kind=source.source_kind,
        created_by=user.id,
    )
    storage_ref = document_store.save(
        project.workspace_id, document.id, document.title, fetched
    )
    document.storage_ref = storage_ref
    repo.create_document(document)

    ocr_provider = getattr(request.app.state, "ocr_provider", None) or StubOcrProvider()
    try:
        result = await extract_text(mime, fetched, ocr_provider)
    except UnsupportedMimeError:
        # ALLOWED_MIMES already gated this above; kept for defense in depth
        # if extract.py's supported set ever narrows independently.
        raise HTTPException(status_code=415, detail="unsupported_media_type") from None
    except Exception:  # noqa: BLE001 - a bad file must never 500 the upload
        logger.exception("document extraction failed document=%s", document.id)
        repo.update_document_extraction(
            project_id,
            document.id,
            status=DocumentStatus.failed,
            extract_method=None,
            extracted_text=None,
        )
        document = repo.get_document(project_id, document.id)
        return DocumentOut(**document.model_dump())

    document = repo.update_document_extraction(
        project_id,
        document.id,
        status=DocumentStatus.extracted,
        extract_method=result.method,
        extracted_text=result.text,
    )
    enqueue(
        request.app,
        EmbedJob(project.workspace_id, project_id, "documents", document.id),
    )
    return DocumentOut(**document.model_dump())


@router.get("/projects/{project_id}/documents/{document_id}/content")
def get_document_content(
    project_id: str,
    document_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Response:
    """Stream the stored file back so the Planner can preview the PRD a member
    uploaded (PDF in a viewer, Markdown rendered) instead of only its name and
    extraction status. Serves the raw bytes, not `extracted_text` — reviewing a
    PRD means seeing the document, layout and all.

    Served `inline` but sandboxed: `mime` is constrained to ALLOWED_MIMES at
    upload, and `nosniff` + a sandbox CSP keep a hostile upload from executing
    as same-origin content on the API domain.
    """
    require_project(repo, project_id, user)
    document = repo.get_document(project_id, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="document_not_found")

    document_store = request.app.state.document_store
    try:
        content = document_store.load(document.storage_ref)
    except DocumentNotStored:
        logger.warning(
            "document bytes missing document=%s ref=%s", document.id, document.storage_ref
        )
        raise HTTPException(status_code=404, detail="document_content_missing") from None

    return Response(
        content=content,
        media_type=document.mime,
        headers={
            "content-disposition": f'inline; filename="{quote(document.title)}"',
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
        },
    )


@router.get("/projects/{project_id}/documents", response_model=list[DocumentOut])
def list_documents(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> list[DocumentOut]:
    require_project(repo, project_id, user)
    return [DocumentOut(**doc.model_dump()) for doc in repo.list_documents(project_id)]
