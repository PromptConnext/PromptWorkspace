# Editable Planner Markdown (Raw|Preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Planner stage (constitution/specify/plan/tasks) a durable, re-fetchable raw-markdown document that a user can view as rendered markdown or edit as raw text, with edits persisted to the cloud and indexed into RAG chat.

**Architecture:** A new `stage_documents` table/model in `apps/cloud`, orthogonal to the existing graph-entity persistence (`Requirement`/`SpecDocument`/`Task`), stores one raw-markdown row per `(project_id, stage)`. Generation auto-saves into it; a new GET/PATCH route pair lets the frontend fetch and edit it. `apps/web` gets a new reusable `MarkdownEditor` component (Raw|Preview tabs) wired into `Planner.tsx`, replacing the current unsaved `<pre>` block.

**Tech Stack:** FastAPI + Pydantic + Supabase/in-memory repository (apps/cloud), Next.js 16 / React 19 / vitest (apps/web), `react-markdown` (new dependency).

## Global Constraints

- Backend membership/auth: every new route must call `require_project(repo, project_id, user)` exactly like `documents.py` and `generation.py` — 403 `not_a_member` for non-members, 404 `project_not_found` for a missing project.
- No changes to `Requirement`/`SpecDocument`/`Task` schemas or to `parse_stage_output`/`_persist_*` functions — the new store is additive and parallel.
- Migration files are forward-only, zero-padded 4-digit sequence, `if not exists`/safe-default DDL, with a `--` header comment explaining why (see `migrations/0018_project_lifecycle.sql`). Next number is `0019`.
- Frontend: no new UI dependency beyond `react-markdown`; `apiFetch<T>(path, authHeaders, init?)` from `src/lib/api.ts` is the only HTTP wrapper — no raw `fetch` in new code except where the codebase already uses raw `fetch` (SSE streaming, unrelated to this plan).
- Spec source of truth: `docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md`.

---

## Task 1: Backend — `StageDocument` model + in-memory repository methods

**Files:**
- Modify: `apps/cloud/app/models/schemas.py`
- Modify: `apps/cloud/app/db/repository.py`
- Test: `apps/cloud/tests/test_stage_documents_repo.py` (new)

**Interfaces:**
- Produces: `StageDocument` pydantic model with fields `id, workspace_id, project_id, stage, content, created_by, updated_at`; `Repository.get_stage_document(project_id: str, stage: str) -> StageDocument | None`; `Repository.upsert_stage_document(project_id: str, workspace_id: str, stage: str, content: str, user_id: str) -> StageDocument`.

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_stage_documents_repo.py`:

```python
"""In-memory repository CRUD for stage_documents — the raw-markdown side
store for Planner stages, independent of the graph-entity persistence
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from app.db.repository import InMemoryRepository


def test_get_stage_document_returns_none_when_absent():
    repo = InMemoryRepository()
    assert repo.get_stage_document("proj-1", "plan") is None


def test_upsert_then_get_roundtrips_content():
    repo = InMemoryRepository()
    doc = repo.upsert_stage_document("proj-1", "ws-1", "plan", "# Plan\n\nDo the thing.", "user-1")
    assert doc.project_id == "proj-1"
    assert doc.stage == "plan"
    assert doc.content == "# Plan\n\nDo the thing."
    assert doc.created_by == "user-1"

    fetched = repo.get_stage_document("proj-1", "plan")
    assert fetched is not None
    assert fetched.content == "# Plan\n\nDo the thing."


def test_upsert_overwrites_existing_content_for_same_stage():
    repo = InMemoryRepository()
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "first draft", "user-1")
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "second draft", "user-1")

    fetched = repo.get_stage_document("proj-1", "plan")
    assert fetched is not None
    assert fetched.content == "second draft"


def test_different_stages_are_independent():
    repo = InMemoryRepository()
    repo.upsert_stage_document("proj-1", "ws-1", "specify", "specify content", "user-1")
    repo.upsert_stage_document("proj-1", "ws-1", "plan", "plan content", "user-1")

    assert repo.get_stage_document("proj-1", "specify").content == "specify content"
    assert repo.get_stage_document("proj-1", "plan").content == "plan content"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents_repo.py -v`
Expected: FAIL — `AttributeError: 'InMemoryRepository' object has no attribute 'get_stage_document'` (or `ImportError` if collection fails first).

- [ ] **Step 3: Add the `StageDocument` model**

In `apps/cloud/app/models/schemas.py`, add near `Document`/`DocumentOut` (same file already imports `Field`, `datetime`, `Literal`, `new_id`, `utcnow` — reuse those, do not re-import):

```python
class StageDocument(BaseModel):
    id: str = Field(default_factory=new_id)
    workspace_id: str
    project_id: str
    stage: Literal["constitution", "specify", "plan", "tasks"]
    content: str = ""
    created_by: str
    updated_at: datetime = Field(default_factory=utcnow)
```

- [ ] **Step 4: Add abstract methods to `Repository`**

In `apps/cloud/app/db/repository.py`, inside `class Repository(abc.ABC):`, add near the existing `get_latest_spec_document`/`create_generation_run` abstract methods:

```python
    @abc.abstractmethod
    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None: ...

    @abc.abstractmethod
    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument: ...
```

Add `StageDocument` to the module's existing import from `app.models.schemas` (find the existing multi-line import at the top of `repository.py` and add `StageDocument` to it alphabetically).

- [ ] **Step 5: Implement on `InMemoryRepository`**

In `InMemoryRepository.__init__`, add alongside the other per-project dict stores:

```python
        # project_id -> stage -> StageDocument (Planner editable-markdown)
        self._stage_documents: dict[str, dict[str, StageDocument]] = {}
```

Add the methods near `get_latest_spec_document`:

```python
    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None:
        doc = self._stage_documents.get(project_id, {}).get(stage)
        return copy.deepcopy(doc) if doc else None

    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument:
        store = self._stage_documents.setdefault(project_id, {})
        existing = store.get(stage)
        doc = StageDocument(
            id=existing.id if existing else new_id(),
            workspace_id=workspace_id,
            project_id=project_id,
            stage=stage,
            content=content,
            created_by=existing.created_by if existing else user_id,
            updated_at=utcnow(),
        )
        store[stage] = doc
        return copy.deepcopy(doc)
```

(`copy`, `new_id`, `utcnow` are already imported/used elsewhere in this file — reuse, do not re-import.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents_repo.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/cloud/app/models/schemas.py apps/cloud/app/db/repository.py apps/cloud/tests/test_stage_documents_repo.py
git commit -m "feat(cloud): add StageDocument model + in-memory repository CRUD"
```

---

## Task 2: Backend — Supabase repository implementation + migration

**Files:**
- Modify: `apps/cloud/app/db/supabase_repository.py`
- Create: `apps/cloud/migrations/0019_stage_documents.sql`

**Interfaces:**
- Consumes: `StageDocument` from Task 1.
- Produces: `SupabaseRepository.get_stage_document` / `.upsert_stage_document`, matching the `Repository` abstract signatures from Task 1 exactly (same parameter names/order), so `app/db/repository.py::_build_repository` (which selects implementation by `Settings.data_backend`) works unchanged.

- [ ] **Step 1: Add the migration**

Create `apps/cloud/migrations/0019_stage_documents.sql`:

```sql
-- PromptConnext Cloud — stage_documents: raw-markdown side store for
-- Planner stages (constitution/specify/plan/tasks), independent of the
-- graph-entity persistence (Requirement/SpecDocument/Task). Lets the
-- Planner tab show a Raw|Preview editor with edits that survive reload and
-- feed into RAG chat (docs/superpowers/specs/2026-07-26-planner-markdown-
-- editor-design.md). One row per (project_id, stage) — a fresh generation
-- or a manual edit overwrites the existing row for that stage, no history.

create table if not exists pz_stage_documents (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id),
    project_id uuid not null references pz_projects (id),
    stage text not null check (stage in ('constitution', 'specify', 'plan', 'tasks')),
    content text not null default '',
    created_by uuid,
    updated_at timestamptz not null default now(),
    unique (project_id, stage)
);
```

- [ ] **Step 2: Add table constant**

In `apps/cloud/app/db/supabase_repository.py`, add near the other `_XXX = "pz_xxx"` module-level constants (alongside `_DOCUMENTS`, `_GENERATION_RUNS`):

```python
_STAGE_DOCUMENTS = "pz_stage_documents"
```

- [ ] **Step 3: Implement the two methods**

Add near the file's `get_latest_spec_document`/`create_generation_run` implementations, following the same `self._client.table(...)` pattern:

```python
    def get_stage_document(self, project_id: str, stage: str) -> StageDocument | None:
        res = (
            self._client.table(_STAGE_DOCUMENTS)
            .select("*")
            .eq("project_id", project_id)
            .eq("stage", stage)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        return StageDocument(**rows[0]) if rows else None

    def upsert_stage_document(
        self, project_id: str, workspace_id: str, stage: str, content: str, user_id: str
    ) -> StageDocument:
        existing = self.get_stage_document(project_id, stage)
        doc = StageDocument(
            id=existing.id if existing else new_id(),
            workspace_id=workspace_id,
            project_id=project_id,
            stage=stage,
            content=content,
            created_by=existing.created_by if existing else user_id,
        )
        self._client.table(_STAGE_DOCUMENTS).upsert(
            _dump(doc), on_conflict="project_id,stage"
        ).execute()
        return doc
```

Add `StageDocument` and `new_id` to this file's existing import from `app.models.schemas` / wherever `new_id` is imported from in this module (check the top-of-file import block and extend it — do not re-declare).

- [ ] **Step 4: Verify with cloud test suite (Supabase path is not exercised by default tests, so this is a syntax/import check only)**

Run: `cd apps/cloud && python -c "import app.db.supabase_repository"`
Expected: no ImportError/SyntaxError output.

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/db/supabase_repository.py apps/cloud/migrations/0019_stage_documents.sql
git commit -m "feat(cloud): add Supabase-backed stage_documents storage + migration"
```

---

## Task 3: Backend — GET/PATCH routes for stage documents

**Files:**
- Create: `apps/cloud/app/api/stage_documents.py`
- Modify: `apps/cloud/app/main.py`
- Test: `apps/cloud/tests/test_stage_documents.py` (new)

**Interfaces:**
- Consumes: `Repository.get_stage_document`/`upsert_stage_document` (Task 1), `require_project` from `app.api._guards`, `EmbedJob`/`enqueue` from `app.rag.queue` (signature: `EmbedJob(workspace_id, project_id, node_type, node_id)`, `enqueue(app, job)`).
- Produces: `GET /projects/{project_id}/stage-documents/{stage}` → `StageDocumentOut{stage, content, updated_at}` (200; empty content object if none exists — no 404). `PATCH /projects/{project_id}/stage-documents/{stage}` body `{content: str}` → same `StageDocumentOut`, 200.

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_stage_documents.py`:

```python
"""GET/PATCH routes for the Planner raw-markdown side store
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}


def _client() -> TestClient:
    app = create_app()
    c = TestClient(app)
    c.__enter__()
    c.app.state.embedding_provider = FakeEmbeddingProvider()
    c.app.state.chat_provider = FakeChatProvider()
    return c


def _bootstrap(client: TestClient) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    return ws["id"], project["id"]


def test_get_returns_empty_content_when_no_document_exists():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    res = client.get(f"/projects/{pid}/stage-documents/plan", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json() == {"stage": "plan", "content": "", "updated_at": None}


def test_patch_then_get_roundtrips_content():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    patch_res = client.patch(
        f"/projects/{pid}/stage-documents/plan",
        json={"content": "# Plan\n\nBuild it."},
        headers=ALICE,
    )
    assert patch_res.status_code == 200, patch_res.text
    assert patch_res.json()["content"] == "# Plan\n\nBuild it."

    get_res = client.get(f"/projects/{pid}/stage-documents/plan", headers=ALICE)
    assert get_res.json()["content"] == "# Plan\n\nBuild it."


def test_non_member_cannot_get_or_patch():
    client = _client()
    _ws_id, pid = _bootstrap(client)

    get_res = client.get(f"/projects/{pid}/stage-documents/plan", headers=BOB)
    assert get_res.status_code == 403

    patch_res = client.patch(
        f"/projects/{pid}/stage-documents/plan", json={"content": "x"}, headers=BOB
    )
    assert patch_res.status_code == 403


def test_patch_enqueues_embed_job_for_rag():
    client = _client()
    ws_id, pid = _bootstrap(client)

    client.patch(
        f"/projects/{pid}/stage-documents/plan", json={"content": "index me"}, headers=ALICE
    )

    queue = client.app.state.embed_queue
    assert not queue.empty()
    job = queue.get_nowait()
    assert job.workspace_id == ws_id
    assert job.project_id == pid
    assert job.node_type == "stage_documents"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents.py -v`
Expected: FAIL — `404 Not Found` on the GET/PATCH calls (no route registered yet), or `AttributeError` if `EmbedQueue` has no `empty()`/`get_nowait()` (check `app/rag/queue.py::EmbedQueue` — it wraps `asyncio.Queue`, which has both; if the actual class differs, adjust the test's queue-draining lines to match, this is the only step allowed to diverge from the code above).

- [ ] **Step 3: Write the route module**

Create `apps/cloud/app/api/stage_documents.py`:

```python
"""Raw-markdown side store for Planner stages — GET/PATCH so the Raw|Preview
editor in apps/web can fetch and persist edits independent of the
graph-entity parsing in app/api/generation.py
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api._guards import require_project
from app.db.repository import Repository
from app.dependencies import User, get_current_user, get_repository
from app.rag.queue import EmbedJob, enqueue
from fastapi import Request

router = APIRouter(tags=["stage_documents"])

StageName = Literal["constitution", "specify", "plan", "tasks"]


class StageDocumentOut(BaseModel):
    stage: str
    content: str
    updated_at: str | None


class StageDocumentUpdate(BaseModel):
    content: str


@router.get("/projects/{project_id}/stage-documents/{stage}", response_model=StageDocumentOut)
def get_stage_document(
    project_id: str,
    stage: StageName,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentOut:
    require_project(repo, project_id, user)
    doc = repo.get_stage_document(project_id, stage)
    if doc is None:
        return StageDocumentOut(stage=stage, content="", updated_at=None)
    return StageDocumentOut(stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat())


@router.patch("/projects/{project_id}/stage-documents/{stage}", response_model=StageDocumentOut)
def update_stage_document(
    project_id: str,
    stage: StageName,
    body: StageDocumentUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> StageDocumentOut:
    project = require_project(repo, project_id, user)
    doc = repo.upsert_stage_document(project_id, project.workspace_id, stage, body.content, user.id)
    enqueue(request.app, EmbedJob(project.workspace_id, project_id, "stage_documents", doc.id))
    return StageDocumentOut(stage=stage, content=doc.content, updated_at=doc.updated_at.isoformat())
```

- [ ] **Step 4: Mount the router**

In `apps/cloud/app/main.py`:
- Add `stage_documents` to the `from app.api import (...)` block, alphabetically (between `sync` and `workspaces`... actually alphabetically it sits between `presence` and `sync`; insert accordingly so the block stays alpha-sorted).
- Add `app.include_router(stage_documents.router)` after `app.include_router(generation.router)` (line 204 today).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents.py -v`
Expected: PASS (4 tests)

- [ ] **Step 6: Run full cloud suite to check no regressions**

Run: `cd apps/cloud && python -m pytest`
Expected: all pass (previous count + 8 new tests from Tasks 1 & 3)

- [ ] **Step 7: Commit**

```bash
git add apps/cloud/app/api/stage_documents.py apps/cloud/app/main.py apps/cloud/tests/test_stage_documents.py
git commit -m "feat(cloud): add GET/PATCH routes for Planner stage documents"
```

---

## Task 4: Backend — auto-save stage document after successful generation

**Files:**
- Modify: `apps/cloud/app/api/generation.py`
- Test: `apps/cloud/tests/test_generation.py` (extend existing — find and add to it; if it doesn't exist, create `apps/cloud/tests/test_generation_autosave.py` following the `test_stage_documents.py` bootstrap pattern)

**Interfaces:**
- Consumes: `Repository.upsert_stage_document` (Task 1), `EmbedJob`/`enqueue` (already imported pattern from Task 3).
- Produces: after `generate()` streams a `done` event, `repo.get_stage_document(project_id, stage)` returns the freshly generated `result.content`.

- [ ] **Step 1: Write the failing test**

Check whether `apps/cloud/tests/test_generation.py` exists:

Run: `ls apps/cloud/tests/test_generation*.py`

If it exists, add this test function to it (matching its existing fixture/mock style — read the file first to match its provider-mocking pattern, e.g. how it stubs `generation_provider`). If it doesn't exist, create `apps/cloud/tests/test_generation_autosave.py`:

```python
"""Verifies generate() auto-saves into stage_documents on success
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.generation.service import GenerationResult
from app.main import create_app
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider


class _FakeGenerationProvider:
    def __init__(self, text: str) -> None:
        self._text = text

    async def stream(self, system_prompt, user_content, model, api_key, base_url):
        yield self._text


ALICE = {"X-User-Id": "alice"}


def _client() -> TestClient:
    app = create_app()
    c = TestClient(app)
    c.__enter__()
    c.app.state.embedding_provider = FakeEmbeddingProvider()
    c.app.state.chat_provider = FakeChatProvider()
    return c


def test_successful_generate_autosaves_stage_document():
    client = _client()
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    client.app.state.generation_provider = _FakeGenerationProvider(
        "# Requirement Title\n\nSome generated body."
    )

    res = client.post(
        f"/projects/{pid}/generate/specify",
        json={"user_input": "build a widget"},
        headers=ALICE,
    )
    assert res.status_code == 200, res.text
    # drain the SSE stream so the generator runs to completion
    for _ in res.iter_lines():
        pass

    doc_res = client.get(f"/projects/{pid}/stage-documents/specify", headers=ALICE)
    assert doc_res.json()["content"] == "# Requirement Title\n\nSome generated body."
```

Note: adjust the fake provider/`GenerationResult` import if the real `test_generation.py` (if found in Step 1) already has an established fake-provider helper — reuse it instead of introducing a second one; the exact parsing format for `specify` (what text `parse_stage_output` expects to produce `result.title`/`result.content`) must match whatever `apps/cloud/app/generation/service.py::parse_stage_output` and `apps/cloud/app/generation/parsing.py` already expect — check `parse_stage_output`'s `specify` branch before finalizing the fake text if this test fails on parsing rather than on the auto-save assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_generation_autosave.py -v` (or the extended `test_generation.py`)
Expected: FAIL on the `doc_res.json()["content"]` assertion (empty string, since nothing saves it yet) — not on the generate call itself. If it fails earlier (e.g. on parsing), adjust the fake generated text to match `parse_stage_output`'s expected input shape for `specify` first, then re-run.

- [ ] **Step 3: Wire the auto-save**

In `apps/cloud/app/api/generation.py`, add the import:

```python
from app.rag.queue import EmbedJob, enqueue
```

Then, inside `stream()`, right after the `payload[...] = _persist_*(...)` try/except block succeeds and before `repo.update_generation_run(..., status="succeeded", ...)` (i.e. insert between the closing of the second `try/except GenerationError` block at line ~185 and the `repo.update_generation_run` call at line ~187):

```python
        stage_doc = repo.upsert_stage_document(
            project_id, project.workspace_id, stage, result.content, user.id
        )
        enqueue(request.app, EmbedJob(project.workspace_id, project_id, "stage_documents", stage_doc.id))

```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_generation_autosave.py -v` (or extended file)
Expected: PASS

- [ ] **Step 5: Run full cloud suite**

Run: `cd apps/cloud && python -m pytest`
Expected: all pass, no regressions in existing `test_generation.py`/`test_routing.py`/`test_managed_tier.py`

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/api/generation.py apps/cloud/tests/test_generation_autosave.py
git commit -m "feat(cloud): auto-save generated stage output into stage_documents"
```

---

## Task 5: Backend — RAG wiring for stage_documents

**Files:**
- Modify: `apps/cloud/app/rag/source.py`
- Modify: `apps/cloud/app/api/assistant.py`
- Test: `apps/cloud/tests/test_rag_source.py` (extend if it exists, else add to `apps/cloud/tests/test_assistant.py` or create `apps/cloud/tests/test_stage_documents_rag.py`)

**Interfaces:**
- Consumes: `StageDocument` (Task 1), existing `RAG_NODE_TYPES` tuple and `node_text()` function in `app/rag/source.py`.
- Produces: `"stage_documents"` is a member of `RAG_NODE_TYPES`; `node_text("stage_documents", stage_document_instance)` returns `stage_document.content.strip()`.

- [ ] **Step 1: Write the failing test**

Create `apps/cloud/tests/test_stage_documents_rag.py`:

```python
"""stage_documents participates in RAG indexing like every other node type
(docs/superpowers/specs/2026-07-26-planner-markdown-editor-design.md)."""

from __future__ import annotations

from app.models.schemas import StageDocument
from app.rag.source import RAG_NODE_TYPES, node_text


def test_stage_documents_is_a_rag_node_type():
    assert "stage_documents" in RAG_NODE_TYPES


def test_node_text_returns_stripped_content():
    doc = StageDocument(
        workspace_id="ws-1",
        project_id="proj-1",
        stage="plan",
        content="  # Plan\n\nBuild it.  \n",
        created_by="user-1",
    )
    assert node_text("stage_documents", doc) == "# Plan\n\nBuild it."
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents_rag.py -v`
Expected: FAIL — `"stage_documents" in RAG_NODE_TYPES` is `False`.

- [ ] **Step 3: Update `source.py`**

In `apps/cloud/app/rag/source.py`:
- Add `StageDocument` to the `from app.models.schemas import (...)` block (alphabetically).
- Add `"stage_documents"` to the `RAG_NODE_TYPES` tuple.
- Add a branch to `node_text()`:

```python
    if node_type == "stage_documents" and isinstance(node, StageDocument):
        return node.content.strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents_rag.py -v`
Expected: PASS

- [ ] **Step 5: Extend `reindex_project` to sweep stage_documents**

In `apps/cloud/app/api/assistant.py`, `reindex_project`'s loop currently skips `("pull_requests", "documents")` because neither is fetchable from `repo.get_graph(project_id)`. `stage_documents` is also not part of `ProjectGraph` (it's a separate per-stage store, not a graph entity — see Task 1), so it needs its own sweep rather than fitting the existing `getattr(graph, node_type)` loop. Add, after the existing `for node_type in RAG_NODE_TYPES:` loop in `reindex_project`:

```python
    for stage in ("constitution", "specify", "plan", "tasks"):
        stage_doc = repo.get_stage_document(project_id, stage)
        if stage_doc is not None:
            enqueue(
                request.app,
                EmbedJob(project.workspace_id, project_id, "stage_documents", stage_doc.id),
            )
            enqueued += 1
```

(`EmbedJob`/`enqueue` are already imported in this file — confirm before adding; if not, add `from app.rag.queue import EmbedJob, enqueue` to the top import block.)

- [ ] **Step 6: Add a reindex coverage test**

Add to the same test file:

```python
def test_reindex_sweeps_stage_documents(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.rag.chat import FakeChatProvider
    from app.rag.embedder import FakeEmbeddingProvider

    ALICE = {"X-User-Id": "alice"}
    app = create_app()
    client = TestClient(app)
    client.__enter__()
    client.app.state.embedding_provider = FakeEmbeddingProvider()
    client.app.state.chat_provider = FakeChatProvider()

    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    pid = project["id"]

    client.patch(f"/projects/{pid}/stage-documents/plan", json={"content": "x"}, headers=ALICE)
    # drain the auto-enqueued job from the PATCH itself before reindexing
    while not client.app.state.embed_queue.empty():
        client.app.state.embed_queue.get_nowait()

    res = client.post(f"/projects/{pid}/assistant/reindex", headers=ALICE)
    assert res.status_code == 200, res.text
    assert res.json()["enqueued"] >= 1
    assert not client.app.state.embed_queue.empty()
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/cloud && python -m pytest tests/test_stage_documents_rag.py -v`
Expected: PASS (3 tests)

- [ ] **Step 8: Run full cloud suite**

Run: `cd apps/cloud && python -m pytest`
Expected: all pass

- [ ] **Step 9: Commit**

```bash
git add apps/cloud/app/rag/source.py apps/cloud/app/api/assistant.py apps/cloud/tests/test_stage_documents_rag.py
git commit -m "feat(cloud): index stage_documents into RAG chat"
```

---

## Task 6: Frontend — add `react-markdown`, `StageDocument` type, and `api.ts` functions

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Produces: `StageDocumentOut{stage: StageKind, content: string, updated_at: string | null}` type; `getStageDocument(projectId: string, stage: StageKind, authHeaders: Record<string, string>): Promise<StageDocumentOut>`; `updateStageDocument(projectId: string, stage: StageKind, content: string, authHeaders: Record<string, string>): Promise<StageDocumentOut>`.

- [ ] **Step 1: Add the dependency**

Run: `cd apps/web && pnpm add react-markdown`

- [ ] **Step 2: Add the type**

In `apps/web/src/lib/types.ts`, add near `DocumentOut` (after the `GenerateErrorEvent` interface, matching the mirror-the-backend-model comment convention at the top of the file):

```ts
export interface StageDocumentOut {
  stage: StageKind;
  content: string;
  updated_at: string | null;
}
```

- [ ] **Step 3: Add the api.ts functions**

In `apps/web/src/lib/api.ts`, add the type import (`StageDocumentOut` alongside existing `Task, WorkspaceMember` import) and the two functions, following the exact `listMembers`/`assignTask` pattern:

```ts
export function getStageDocument(
  projectId: string,
  stage: StageKind,
  authHeaders: Record<string, string>,
) {
  return apiFetch<StageDocumentOut>(`/projects/${projectId}/stage-documents/${stage}`, authHeaders);
}

export function updateStageDocument(
  projectId: string,
  stage: StageKind,
  content: string,
  authHeaders: Record<string, string>,
) {
  return apiFetch<StageDocumentOut>(`/projects/${projectId}/stage-documents/${stage}`, authHeaders, {
    method: "PATCH",
    body: JSON.stringify({ content }),
  });
}
```

Add `StageKind` to the type import line too (`import type { StageKind, Task, WorkspaceMember } from "./types";`).

- [ ] **Step 4: Typecheck**

Run: `cd apps/web && pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/lib/types.ts apps/web/src/lib/api.ts
git commit -m "feat(web): add react-markdown dependency and stage-document API client"
```

---

## Task 7: Frontend — reusable `MarkdownEditor` component

**Files:**
- Create: `apps/web/src/components/ui/MarkdownEditor.tsx`
- Test: `apps/web/src/components/ui/MarkdownEditor.test.tsx` (new)

**Interfaces:**
- Consumes: `react-markdown`'s default export (`ReactMarkdown`).
- Produces: `MarkdownEditor({ value, onChange, onSave, saving?, error? }): JSX.Element`, named export, first component under a new `components/ui/` directory.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/ui/MarkdownEditor.test.tsx`:

```tsx
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";

afterEach(() => {
  cleanup();
});

describe("MarkdownEditor", () => {
  it("shows the raw textarea by default with the given value", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("# Hello");
  });

  it("calls onChange when the raw textarea is edited", () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value="# Hello" onChange={onChange} onSave={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# Hello world" } });
    expect(onChange).toHaveBeenCalledWith("# Hello world");
  });

  it("switches to rendered markdown when Preview is clicked", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /preview/i }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });

  it("calls onSave when Save is clicked", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("disables Save while saving", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} saving />);
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
  });

  it("shows the error banner when error is set", () => {
    render(<MarkdownEditor value="# Hello" onChange={vi.fn()} onSave={vi.fn()} error="save failed" />);
    expect(screen.getByText("save failed")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/ui/MarkdownEditor.test.tsx`
Expected: FAIL — module `./MarkdownEditor` not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/ui/MarkdownEditor.tsx`:

```tsx
// apps/web/src/components/ui/MarkdownEditor.tsx
"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

type Mode = "raw" | "preview";

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  saving = false,
  error = null,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving?: boolean;
  error?: string | null;
}) {
  const [mode, setMode] = useState<Mode>("raw");

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded px-2 py-1 text-xs ${
              mode === "raw" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Raw
          </button>
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`rounded px-2 py-1 text-xs ${
              mode === "preview" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Preview
          </button>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave()}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs hover:border-slate-400 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="p-3">
        {mode === "raw" ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs text-slate-800"
          />
        ) : (
          <div className="prose prose-sm max-w-none text-slate-800">
            <ReactMarkdown>{value}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/components/ui/MarkdownEditor.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/MarkdownEditor.tsx apps/web/src/components/ui/MarkdownEditor.test.tsx
git commit -m "feat(web): add reusable MarkdownEditor (Raw|Preview) component"
```

---

## Task 8: Frontend — wire `MarkdownEditor` into `Planner.tsx`

**Files:**
- Modify: `apps/web/src/components/project/Planner.tsx`
- Modify: `apps/web/src/components/project/Planner.test.tsx`

**Interfaces:**
- Consumes: `MarkdownEditor` (Task 7), `getStageDocument`/`updateStageDocument` (Task 6).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/project/Planner.test.tsx`, replacing the `beforeEach`'s blanket `global.fetch` stub with one that also handles the new stage-document GET the component will issue on mount, and adding a new test:

```tsx
import { render, screen, cleanup, waitFor } from "@testing-library/react";
```
(add `waitFor` to the existing import from `@testing-library/react`)

Update `beforeEach` to branch on URL:

```tsx
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;
  });
```

Add a new test:

```tsx
  it("hydrates the MarkdownEditor from the persisted stage document on mount", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/specify")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "# Existing spec", updated_at: "2026-07-26T00:00:00Z" }),
        });
      }
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "plan", content: "", updated_at: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("# Existing spec")).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/components/project/Planner.test.tsx`
Expected: FAIL — no `getByDisplayValue("# Existing spec")` found (Planner doesn't fetch/render it yet).

- [ ] **Step 3: Update `StageSection` in `Planner.tsx`**

Replace the full file's `StageSection` function and its imports:

```tsx
// apps/web/src/components/project/Planner.tsx
"use client";

import { useEffect, useState } from "react";
import { apiFetch, getStageDocument, updateStageDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentUpload } from "./DocumentUpload";
import { useStageGeneration } from "./useStageGeneration";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import type { DocumentOut, Project, StageKind } from "@/lib/types";
```

Replace the `StageSection` function body:

```tsx
function StageSection({
  projectId,
  stage,
  label,
  buttonLabel,
}: {
  projectId: string;
  stage: StageKind;
  label: string;
  buttonLabel: string;
}) {
  const { authHeaders } = useAuth();
  const [input, setInput] = useState("");
  const { status, streamedText, result, error, generate } = useStageGeneration(projectId);

  const [docContent, setDocContent] = useState("");
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStageDocument(projectId, stage, authHeaders())
      .then((doc) => {
        if (!cancelled) setDocContent(doc.content);
      })
      .catch(() => {
        // 404-as-empty is handled server-side (returns content: ""); any
        // other failure just leaves the editor empty rather than blocking render.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage]);

  useEffect(() => {
    if (status === "done" && result) {
      setDocContent(result.content);
    }
  }, [status, result]);

  async function saveDoc() {
    setDocSaving(true);
    setDocError(null);
    try {
      await updateStageDocument(projectId, stage, docContent, authHeaders());
    } catch (err) {
      setDocError((err as Error).message);
    } finally {
      setDocSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">{label}</h3>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        className="mb-2 w-full rounded border border-slate-300 p-2 text-sm"
        placeholder="Describe the goal in plain business terms…"
      />
      <button
        type="button"
        disabled={status === "generating" || !input.trim()}
        onClick={() => generate(stage, input)}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-60"
      >
        {status === "generating" ? "Generating…" : buttonLabel}
      </button>

      {status === "generating" && streamedText && (
        <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
          {streamedText}
        </pre>
      )}
      {status === "error" && error && (
        <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
          <p>{error.error}</p>
          {error.retryable && (
            <button
              type="button"
              onClick={() => generate(stage, input)}
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {status === "done" && result && (
        <p className="mt-2 text-xs text-slate-500">
          {result.task_count !== undefined
            ? `${result.task_count} tasks created`
            : "Saved as a draft"}
        </p>
      )}

      {docContent && (
        <div className="mt-3">
          <MarkdownEditor
            value={docContent}
            onChange={setDocContent}
            onSave={saveDoc}
            saving={docSaving}
            error={docError}
          />
        </div>
      )}
    </div>
  );
}
```

Note the `<pre>` block now only shows while `status === "generating"` (live streaming feedback) — once `status === "done"`, the content lives in `MarkdownEditor` instead, so it isn't shown twice.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm exec vitest run src/components/project/Planner.test.tsx`
Expected: PASS (all tests, including the new hydration test)

- [ ] **Step 5: Run the full web test suite and typecheck**

Run: `cd apps/web && pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: all pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/project/Planner.tsx apps/web/src/components/project/Planner.test.tsx
git commit -m "feat(web): wire MarkdownEditor into Planner stages with persisted hydration"
```

---

## Post-implementation check

- [ ] Run `cd apps/cloud && ruff check .` — expect clean.
- [ ] Run `cd apps/cloud && python -m pytest` — full suite green.
- [ ] Run `cd apps/web && pnpm exec vitest run && pnpm exec tsc --noEmit` — full suite green, no type errors.
- [ ] Manually smoke-test: start `apps/cloud` (`uvicorn app.main:app --reload --port 8080`) and `apps/web` (`pnpm web`), generate a `specify` stage in the Planner tab, confirm the editor shows the generated markdown, switch to Preview, edit in Raw, Save, reload the page, confirm the edit persisted.
