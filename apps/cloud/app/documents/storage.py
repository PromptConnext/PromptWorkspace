"""Raw document storage (M0, plan 0007).

Mirrors the `SecretStore` seam (app/secrets.py): one interface, a dependency-
free in-memory implementation for `data_backend=memory` (tests/local dev),
and a Supabase Storage-backed implementation for production. The uploaded
file's *bytes* only ever live here — `Document.storage_ref` is an opaque
pointer, never the content itself, matching the rest of the row.
"""

from __future__ import annotations

import abc

_BUCKET = "pz-documents"


class DocumentStore(abc.ABC):
    @abc.abstractmethod
    def save(self, workspace_id: str, document_id: str, filename: str, content: bytes) -> str:
        """Persist `content`, return an opaque `storage_ref`."""


class MemoryDocumentStore(DocumentStore):
    """Dev/test store used with `data_backend=memory`, which never persists
    beyond the process anyway."""

    def __init__(self) -> None:
        self._files: dict[str, bytes] = {}

    def save(self, workspace_id: str, document_id: str, filename: str, content: bytes) -> str:
        ref = f"memory://{workspace_id}/{document_id}/{filename}"
        self._files[ref] = content
        return ref


class SupabaseDocumentStore(DocumentStore):
    """Production store: Supabase Storage, bucket `pz-documents` (see
    migrations/0013_documents.sql for the bucket + RLS policy). Objects are
    keyed `<workspace_id>/<document_id>/<filename>` so the RLS policy can
    check the workspace segment of the path directly."""

    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client  # lazy import

        self._client = create_client(url, key)

    def save(self, workspace_id: str, document_id: str, filename: str, content: bytes) -> str:
        path = f"{workspace_id}/{document_id}/{filename}"
        self._client.storage.from_(_BUCKET).upload(path, content)
        return path


def build_document_store(data_backend: str, supabase_url: str, supabase_key: str) -> DocumentStore:
    if data_backend == "supabase":
        return SupabaseDocumentStore(supabase_url, supabase_key)
    return MemoryDocumentStore()
