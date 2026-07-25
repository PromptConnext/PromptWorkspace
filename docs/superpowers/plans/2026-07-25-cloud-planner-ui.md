# Cloud Planner UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a business user with no desktop app create a project, upload a PRD (PDF/Markdown), and generate specs/plan/tasks via the cloud Spec Kit path against managed Typhoon — plus the shared project-lifecycle contract (`planning → pending_tech_review → tech_review → repo_created`) that later sub-projects (Tech Lead review, GitHub repo creation, desktop clone-detection) build on.

**Architecture:** `apps/cloud`'s Spec Kit generation endpoints (`app/api/generation.py`) and document upload (`app/api/documents.py`) already exist — this plan removes the BYO-model path from the Planner (managed Typhoon only), replaces silent-broken RAG retrieval with full-text document injection, adds the `lifecycle_status`/`repo_url`/`repo_default_branch` columns + a `submit-for-review` transition, and builds the missing `apps/web` frontend (New Project action, a Planner tab with upload + stage stepper + SSE streaming) on top.

**Tech Stack:** FastAPI/Python (apps/cloud, pytest + `TestClient`), Next.js 16/React 19 (apps/web, vitest + `@testing-library/react`), TypeScript (apps/engine, `node --test`).

## Global Constraints

- No BYO model connection anywhere in the Planner (constitution/specify/plan/tasks) — always managed Typhoon. The RAG Assistant's separate BYO path (`app/rag/models.py`) is untouched.
- PRD grounding uses full-text document injection, not embedding-based retrieval, for the Planner's `specify`/`plan` stages.
- Lifecycle transitions with an external/irreversible side effect are explicit user actions; internal bookkeeping transitions can be automatic. This plan only implements `planning → pending_tech_review` (explicit, business-user "Send to Tech Lead").
- Follow existing code conventions exactly: FastAPI routers use `Depends(get_current_user)`/`Depends(get_repository)` + `require_project`/`require_workspace` guards; Supabase repository updates use a `patch` dict + `.update(patch).eq(...).execute()` + refetch; migrations are plain `alter table ... add column if not exists`, no transaction wrapper, no RLS.
- Web pages are `"use client"` components using `useCloudGet`/`apiFetch` (`apps/web/src/lib/hooks.ts`, `apps/web/src/lib/api.ts`) — no new data-fetching abstraction.

---

## Task 1: Project lifecycle schema — migration + `Project` model fields

**Files:**
- Create: `apps/cloud/migrations/0018_project_lifecycle.sql`
- Modify: `apps/cloud/app/models/schemas.py:317-325` (the `Project` class)
- Test: `apps/cloud/tests/test_lifecycle.py` (new)

**Interfaces:**
- Produces: `Project.lifecycle_status: Literal["planning", "pending_tech_review", "tech_review", "repo_created"]` (default `"planning"`), `Project.repo_url: str | None`, `Project.repo_default_branch: str | None` — every later task in this plan reads/writes these three fields by exact name.

- [ ] **Step 1: Write the failing test**

```python
# apps/cloud/tests/test_lifecycle.py
"""Project lifecycle: planning -> pending_tech_review -> tech_review ->
repo_created (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md,
"Project Lifecycle & Cloud<->Desktop Coordination"). This plan only
implements the default status and the business-user "Send to Tech Lead"
transition — later sub-projects own the rest of the state machine.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app

ALICE = {"X-User-Id": "alice"}


def _client() -> TestClient:
    app = create_app()
    return TestClient(app)


def test_new_project_defaults_to_planning():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        assert project["lifecycle_status"] == "planning"
        assert project["repo_url"] is None
        assert project["repo_default_branch"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py -v`
Expected: FAIL with `KeyError: 'lifecycle_status'` (the field doesn't exist on `Project` yet).

- [ ] **Step 3: Add the fields to `Project` and write the migration**

In `apps/cloud/app/models/schemas.py`, the `Project` class currently reads (lines 317-325):

```python
class Project(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    workspace_id: str
    owner_id: str
    onboarding_state: OnboardingState = OnboardingState.not_started
    stage_state: dict[str, StageStatus] = Field(default_factory=lambda: {
        "scope": StageStatus.active, "spec": StageStatus.locked, "skill": StageStatus.locked,
    })
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
```

Change it to add the three new fields (keep everything else identical):

```python
class Project(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    workspace_id: str
    owner_id: str
    onboarding_state: OnboardingState = OnboardingState.not_started
    stage_state: dict[str, StageStatus] = Field(default_factory=lambda: {
        "scope": StageStatus.active, "spec": StageStatus.locked, "skill": StageStatus.locked,
    })
    # Cloud Planner lifecycle (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md):
    # planning -> pending_tech_review -> tech_review -> repo_created. Linear,
    # no going back — iteration happens within a state.
    lifecycle_status: Literal["planning", "pending_tech_review", "tech_review", "repo_created"] = (
        "planning"
    )
    repo_url: str | None = None
    repo_default_branch: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
```

Check the top of `schemas.py` already imports `Literal` from `typing` (it does — used elsewhere, e.g. `Document.source_kind`); no new import needed.

Create `apps/cloud/migrations/0018_project_lifecycle.sql`:

```sql
-- PromptConnext Cloud — project lifecycle status + repo linkage (cloud
-- Planner UI, sub-project A). Tracks the planning -> pending_tech_review ->
-- tech_review -> repo_created handoff between business user, Tech Lead, and
-- desktop app (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md).
-- Additive & backward-compatible: existing rows default to 'planning'.

alter table pz_projects add column if not exists lifecycle_status text not null default 'planning';
alter table pz_projects add column if not exists repo_url text;
alter table pz_projects add column if not exists repo_default_branch text;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/migrations/0018_project_lifecycle.sql apps/cloud/app/models/schemas.py apps/cloud/tests/test_lifecycle.py
git commit -m "feat(cloud): add project lifecycle_status/repo_url/repo_default_branch fields"
```

---

## Task 2: Repository method — `update_project_lifecycle_status`

**Files:**
- Modify: `apps/cloud/app/db/repository.py` (abstract method after `list_projects_by_workspace`, ~line 125; `InMemoryRepository` impl near `create_project`, ~line 496)
- Modify: `apps/cloud/app/db/supabase_repository.py` (impl near `create_project`, ~line 239)
- Test: `apps/cloud/tests/test_lifecycle.py` (extend)

**Interfaces:**
- Consumes: `Project` type from Task 1 (with `lifecycle_status` field).
- Produces: `Repository.update_project_lifecycle_status(self, project_id: str, status: str) -> Project` — Task 3's submit-for-review route calls this exact method.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_lifecycle.py`:

```python
def test_update_project_lifecycle_status_persists():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()

        repo = client.app.state.repository
        updated = repo.update_project_lifecycle_status(project["id"], "pending_tech_review")
        assert updated.lifecycle_status == "pending_tech_review"

        refetched = repo.get_project(project["id"])
        assert refetched.lifecycle_status == "pending_tech_review"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py::test_update_project_lifecycle_status_persists -v`
Expected: FAIL with `AttributeError: 'InMemoryRepository' object has no attribute 'update_project_lifecycle_status'`

- [ ] **Step 3: Implement**

In `apps/cloud/app/db/repository.py`, add the abstract method right after `list_projects_by_workspace` (line 125):

```python
    @abc.abstractmethod
    def list_projects_by_workspace(self, workspace_id: str) -> list[Project]: ...

    @abc.abstractmethod
    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project: ...
```

In the same file, find `InMemoryRepository.create_project` (~line 496) and add the new method right after `get_project` (~line 502):

```python
    def get_project(self, project_id: str) -> Project | None:
        return self._projects.get(project_id)

    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        project = self._projects[project_id]
        updated = project.model_copy(update={"lifecycle_status": status, "updated_at": utcnow()})
        self._projects[project_id] = updated
        return updated
```

(Confirm `utcnow` is already imported at the top of `repository.py` — it's used by `Project`'s own `Field(default_factory=utcnow)` import chain from `app.models.schemas`; import it directly if not already present: `from app.models.schemas import utcnow` alongside the existing schema imports in that file.)

In `apps/cloud/app/db/supabase_repository.py`, find `create_project` (~line 239) and add the new method right after `get_project` (~line 244), matching the existing `patch`-dict update convention used by `update_document_extraction`/`update_workspace`:

```python
    def update_project_lifecycle_status(self, project_id: str, status: str) -> Project:
        patch = {"lifecycle_status": status, "updated_at": utcnow().isoformat()}
        self._client.table(_PROJECTS).update(patch).eq("id", project_id).execute()
        project = self.get_project(project_id)
        if project is None:
            raise KeyError("project_not_found")
        return project
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py -v`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/db/repository.py apps/cloud/app/db/supabase_repository.py apps/cloud/tests/test_lifecycle.py
git commit -m "feat(cloud): add update_project_lifecycle_status to Repository"
```

---

## Task 3: `POST /projects/{id}/lifecycle/submit-for-review`

**Files:**
- Modify: `apps/cloud/app/api/sync.py` (add route after `get_project`, ~line 72)
- Test: `apps/cloud/tests/test_lifecycle.py` (extend)

**Interfaces:**
- Consumes: `repo.get_graph(project_id)` (existing, returns `ProjectGraph` with `.requirements`/`.spec_documents`/`.tasks` lists), `repo.update_project_lifecycle_status` from Task 2.
- Produces: `POST /projects/{project_id}/lifecycle/submit-for-review` → `200 Project` on success, `400 {"detail": "planning_incomplete"}` if no requirement/spec/task exists yet, `409 {"detail": "not_in_planning"}` if already past `planning`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cloud/tests/test_lifecycle.py`:

```python
def test_submit_for_review_requires_full_spec_kit_output():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()

        res = client.post(
            f"/projects/{project['id']}/lifecycle/submit-for-review", headers=ALICE
        )
        assert res.status_code == 400
        assert res.json()["detail"] == "planning_incomplete"


def test_submit_for_review_transitions_planning_to_pending_tech_review():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]

        # Directly seed a minimal graph — this test is about the lifecycle
        # transition, not generation (see test_generation.py for that).
        repo = client.app.state.repository
        from app.models.schemas import GraphUpsertRequest, Requirement, SpecDocument, Task

        requirement = Requirement(project_id=pid, title="R")
        repo.upsert_graph(pid, GraphUpsertRequest(requirements=[requirement]), source="pz")
        spec = SpecDocument(project_id=pid, requirement_id=requirement.id, content="plan")
        repo.upsert_graph(pid, GraphUpsertRequest(spec_documents=[spec]), source="pz")
        task = Task(project_id=pid, spec_id=spec.id, title="T1")
        repo.upsert_graph(pid, GraphUpsertRequest(tasks=[task]), source="pz")

        res = client.post(f"/projects/{pid}/lifecycle/submit-for-review", headers=ALICE)
        assert res.status_code == 200, res.text
        assert res.json()["lifecycle_status"] == "pending_tech_review"


def test_submit_for_review_rejects_when_not_in_planning():
    with _client() as client:
        ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
        project = client.post(
            "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
        ).json()
        pid = project["id"]
        client.app.state.repository.update_project_lifecycle_status(pid, "tech_review")

        res = client.post(f"/projects/{pid}/lifecycle/submit-for-review", headers=ALICE)
        assert res.status_code == 409
        assert res.json()["detail"] == "not_in_planning"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py -v`
Expected: FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Implement**

In `apps/cloud/app/api/sync.py`, add the new route right after `get_project` (line 72, before `assign_task`):

```python
@router.post("/projects/{project_id}/lifecycle/submit-for-review", response_model=Project)
def submit_for_review(
    project_id: str,
    user: User = Depends(get_current_user),
    repo: Repository = Depends(get_repository),
) -> Project:
    """Business user signals planning is done (explicit — a Tech Lead
    shouldn't be pulled in on a project still being iterated). No side
    effect beyond the status flip; the Tech Lead's own actions drive
    everything after this (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md)."""
    project = require_project(repo, project_id, user)
    if project.lifecycle_status != "planning":
        raise HTTPException(status_code=409, detail="not_in_planning")

    graph = repo.get_graph(project_id)
    if not (graph.requirements and graph.spec_documents and graph.tasks):
        raise HTTPException(status_code=400, detail="planning_incomplete")

    return repo.update_project_lifecycle_status(project_id, "pending_tech_review")
```

No new imports needed — `HTTPException` is already imported (used by `assign_task`), `Project` and `require_project`/`get_current_user`/`get_repository`/`Repository` are already imported at the top of `sync.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_lifecycle.py -v`
Expected: PASS (all four tests in the file)

- [ ] **Step 5: Commit**

```bash
git add apps/cloud/app/api/sync.py apps/cloud/tests/test_lifecycle.py
git commit -m "feat(cloud): add POST /projects/{id}/lifecycle/submit-for-review"
```

---

## Task 4: Remove BYO from Planner model routing

**Files:**
- Modify: `apps/cloud/app/generation/routing.py` (whole file — simplify)
- Modify: `apps/cloud/app/api/generation.py:37,74-75` (drop `PlanRequiresModelError` import/catch)
- Delete: `apps/cloud/app/api/routing.py`
- Delete: `apps/cloud/tests/test_routing.py`
- Modify: `apps/cloud/app/main.py` (remove `routing` import and `app.include_router(routing.router)`)
- Test: `apps/cloud/tests/test_generation.py` (extend — see Task 5, which touches the same test file; do this task's test assertions there since Task 5 already has to rewrite `_bootstrap`)

**Interfaces:**
- Produces: `select_model(repo, workspace_id, project_id, stage, managed_connection) -> ModelConnection | None` — now always returns `managed_connection` regardless of `stage`, `repo`, or `project_id` (kept as unused params so `app/api/generation.py`'s call site doesn't need to change).

- [ ] **Step 1: Write the failing test**

This task's behavior (plan stage no longer needs BYO) is verified by Task 5's rewritten `test_plan_creates_spec_document_against_latest_requirement`, since that test currently would need a BYO connection under the old code and won't have one after Task 5's `_bootstrap` rewrite. Do this task first (it's a prerequisite for Task 5's fixture to work), then confirm both together:

Run: `cd apps/cloud && python -m pytest tests/test_generation.py::test_plan_creates_spec_document_against_latest_requirement -v`
Expected (before this task's implementation, with Task 5's `_bootstrap` already showing no BYO connection): FAIL with 409 `plan requires a connected model`.

(If you're implementing tasks in order, do Task 5's `_bootstrap` rewrite first so this failing state is reproducible, then come back — the two tasks are interdependent on this one point. Simplest: implement this task's code changes now, then do Task 5 immediately after, and run both test files together at the end of Task 5.)

- [ ] **Step 2: Simplify `app/generation/routing.py`**

Replace the entire file:

```python
"""Model-selection seam (M1, plan 0007; managed fallback added M2). The
Planner always uses the managed Typhoon connection — no BYO model, no
per-stage routing table (removed, docs/superpowers/specs/2026-07-25-cloud-
planner-ui-design.md: "No BYO model in the cloud Planner"). Developers who
want their own model plan through the desktop app instead (apps/engine's
own `runStage()`), which is untouched by this change.
"""

from __future__ import annotations

from app.models.schemas import ModelConnection


def select_model(
    managed_connection: ModelConnection | None = None,
) -> ModelConnection | None:
    return managed_connection
```

- [ ] **Step 3: Update the call site in `app/api/generation.py`**

Current code (lines 37, 71-77):

```python
from app.generation.routing import PlanRequiresModelError, select_model
```

```python
    managed_connection = getattr(request.app.state, "managed_connection", None)
    try:
        conn = select_model(repo, project.workspace_id, project_id, stage, managed_connection)
    except PlanRequiresModelError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if conn is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")
```

Change the import to:

```python
from app.generation.routing import select_model
```

And simplify the call site (the `try`/`except PlanRequiresModelError` is gone since that error class no longer exists):

```python
    managed_connection = getattr(request.app.state, "managed_connection", None)
    conn = select_model(managed_connection)
    if conn is None:
        raise HTTPException(status_code=400, detail="model_connection_not_configured")
```

- [ ] **Step 4: Delete the routing settings API and its test**

```bash
rm apps/cloud/app/api/routing.py apps/cloud/tests/test_routing.py
```

In `apps/cloud/app/main.py`, remove `routing` from the `from app.api import (...)` block (line 28) and remove the line `app.include_router(routing.router)` (line 206). The import block goes from:

```python
from app.api import (
    assistant,
    desktop_auth,
    discussions,
    documents,
    generation,
    github,
    health,
    integrations,
    presence,
    routing,
    sync,
    workspaces,
)
```

to:

```python
from app.api import (
    assistant,
    desktop_auth,
    discussions,
    documents,
    generation,
    github,
    health,
    integrations,
    presence,
    sync,
    workspaces,
)
```

And the registration block loses its `routing` line:

```python
    app.include_router(generation.router)
    app.include_router(desktop_auth.router)
```

(was `app.include_router(generation.router)` / `app.include_router(routing.router)` / `app.include_router(desktop_auth.router)` — just delete the middle line.)

- [ ] **Step 5: Run the full cloud test suite to check for breakage**

Run: `cd apps/cloud && python -m pytest -v 2>&1 | tail -60`
Expected: `test_routing.py` no longer collected (deleted). `test_generation.py`'s `test_plan_requires_a_requirement_first` and `test_plan_creates_spec_document_against_latest_requirement` will still be RED at this point — that's expected, Task 5 fixes their fixture. Every other file should stay green. If anything outside `test_generation.py` fails, stop and investigate before continuing — don't proceed into Task 5 with an unrelated regression.

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/generation/routing.py apps/cloud/app/api/generation.py apps/cloud/app/main.py
git rm apps/cloud/app/api/routing.py apps/cloud/tests/test_routing.py
git commit -m "feat(cloud): remove BYO model routing from the Planner (managed Typhoon only)"
```

---

## Task 5: Full-text PRD injection replacing dead RAG-retrieval path

**Files:**
- Modify: `apps/cloud/app/api/generation.py` (the `generate()` function's context-building branch, ~lines 71-119)
- Modify: `apps/cloud/tests/test_generation.py` (rewrite `_bootstrap`, fixture, and the specify-grounding test)

**Interfaces:**
- Consumes: `repo.list_documents(project_id) -> list[Document]` (existing, `apps/cloud/app/db/repository.py:301`), `Document.extracted_text: str | None` and `Document.title: str` (existing, `apps/cloud/app/models/schemas.py:636-649`).
- Produces: the `specify`/`plan` stages' prompt context now contains every extracted document's full text (capped), instead of top-8 embedding-search chunks.

- [ ] **Step 1: Rewrite the test fixture and grounding test**

The current `apps/cloud/tests/test_generation.py` `_bootstrap` (lines 54-72) creates a BYO model connection with an `embed_model`, which no longer applies (Task 4 removed BYO from the Planner entirely). Replace the whole file's fixture/bootstrap/grounding test:

```python
# apps/cloud/tests/test_generation.py — update the docstring, fixture, and
# _bootstrap; only the grounding test's body changes beyond that.

"""Stage generation endpoints (M1, plan 0007) — cloud-side Spec Kit path,
managed Typhoon only (BYO removed, docs/superpowers/specs/2026-07-25-cloud-
planner-ui-design.md).

Exit criteria under test: each stage streams a parsed artifact; `specify`
visibly reflects a PRD uploaded in M0 via full-text injection (a fact only
present in the uploaded document appears in the generated spec);
`specify`/`plan`/`tasks` persist into the project graph (Requirement /
SpecDocument / Task, the last with `{text: str}[]` acceptance criteria —
CLAUDE.md's shape is unchanged); `plan`/`tasks` 409 without their
prerequisite; a non-member is 403; an over-budget workspace is 429; the run
is recorded in generation_runs.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.generation.managed import MANAGED_WORKSPACE_MARKER
from app.generation.service import FakeGenerationProvider
from app.main import create_app
from app.models.schemas import ModelConnection
from app.rag.chat import FakeChatProvider
from app.rag.embedder import FakeEmbeddingProvider

ALICE = {"X-User-Id": "alice"}
BOB = {"X-User-Id": "bob"}

CONSTITUTION_INPUT = "Ship fast, keep it simple, and always write tests before merging any change."
SPECIFY_INPUT = "Support the new payments rollout across every region we currently operate in."
PLAN_INPUT = "Plan out the technical implementation for the payments rollout in detail."
TASKS_INPUT = "Break the approved implementation plan into small, independently shippable tasks."


def _managed_connection(daily_token_budget: int = 200_000) -> ModelConnection:
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


@pytest.fixture
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as c:
        c.app.state.embedding_provider = FakeEmbeddingProvider()
        c.app.state.chat_provider = FakeChatProvider()
        c.app.state.generation_provider = FakeGenerationProvider()
        c.app.state.managed_connection = _managed_connection()
        c.app.state.secret_store.decrypt = lambda _ref: "platform-key"
        yield c


def _bootstrap(client: TestClient, daily_token_budget: int = 200_000) -> tuple[str, str]:
    ws = client.post("/workspaces", json={"name": "W"}, headers=ALICE).json()
    project = client.post(
        "/projects", json={"name": "P", "workspace_id": ws["id"]}, headers=ALICE
    ).json()
    client.app.state.managed_connection = _managed_connection(daily_token_budget)
    return ws["id"], project["id"]


def _sse_events(body: str) -> dict[str, dict]:
    """Parse the last `data:` payload for each named SSE event out of the
    raw response body."""
    events: dict[str, dict] = {}
    current_event = "message"
    for line in body.splitlines():
        if line.startswith("event:"):
            current_event = line[len("event:") :].strip()
        elif line.startswith("data:"):
            payload = line[len("data:") :].strip()
            if payload:
                events[current_event] = json.loads(payload)
    return events


def _generate(client: TestClient, pid: str, stage: str, user_input: str, headers=ALICE):
    return client.post(
        f"/projects/{pid}/generate/{stage}",
        json={"user_input": user_input},
        headers=headers,
    )


def test_constitution_streams_artifact_and_records_run(client: TestClient):
    ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", CONSTITUTION_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "content" in events["done"]
    assert events["done"]["content"].startswith("# ")

    repo = client.app.state.repository
    runs = list(repo._generation_runs.values())  # test-only reach into InMemoryRepository internals
    assert any(
        r.workspace_id == ws_id and r.stage == "constitution" and r.status == "succeeded"
        for r in runs
    )


def test_specify_grounds_on_uploaded_document_via_full_text_injection(client: TestClient):
    ws_id, pid = _bootstrap(client)

    upload = client.post(
        f"/projects/{pid}/documents",
        files={
            "file": (
                "prd.md",
                b"# PRD\n\nThe rollout must support the Thai QR payment rail codenamed ZEBRA-PAY.",
                "text/markdown",
            )
        },
        headers=ALICE,
    )
    assert upload.status_code == 201, upload.text
    assert upload.json()["status"] == "extracted"

    # No embedding wait needed — full-text injection reads the document
    # directly, not via the async embed-on-ingest queue.
    res = _generate(client, pid, "specify", SPECIFY_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert "ZEBRA-PAY" in events["done"]["content"]

    requirement_id = events["done"]["requirement_id"]
    repo = client.app.state.repository
    requirement = repo.get_latest_requirement(pid)
    assert requirement is not None
    assert requirement.id == requirement_id
    assert requirement.description == SPECIFY_INPUT


def test_plan_requires_a_requirement_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 409


def test_plan_creates_spec_document_against_latest_requirement(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)

    res = _generate(client, pid, "plan", PLAN_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    spec_id = events["done"]["spec_document_id"]

    repo = client.app.state.repository
    spec = repo.get_latest_spec_document(pid)
    assert spec is not None
    assert spec.id == spec_id


def test_tasks_requires_a_spec_document_first(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 409


def test_tasks_creates_tasks_with_text_acceptance_criteria(client: TestClient):
    _ws_id, pid = _bootstrap(client)
    _generate(client, pid, "specify", SPECIFY_INPUT)
    _generate(client, pid, "plan", PLAN_INPUT)

    res = _generate(client, pid, "tasks", TASKS_INPUT)
    assert res.status_code == 200, res.text
    events = _sse_events(res.text)
    assert events["done"]["task_count"] > 0

    repo = client.app.state.repository
    project_store = repo._graph[pid]  # test-only reach into InMemoryRepository internals
    tasks = list(project_store["tasks"].values())
    assert len(tasks) == events["done"]["task_count"]
    for task in tasks:
        assert task.acceptance_criteria
        assert all(hasattr(c, "text") for c in task.acceptance_criteria)


def test_non_member_cannot_generate(client: TestClient):
    _ws_id, pid = _bootstrap(client)

    res = _generate(client, pid, "constitution", "hi", headers=BOB)
    assert res.status_code == 403


def test_over_budget_workspace_is_429(client: TestClient):
    _ws_id, pid = _bootstrap(client, daily_token_budget=0)

    res = _generate(client, pid, "constitution", "hi")
    assert res.status_code == 429
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cloud && python -m pytest tests/test_generation.py -v`
Expected: FAIL — `test_specify_grounds_on_uploaded_document_via_full_text_injection` (the embedding branch never fires for the managed connection, so `ZEBRA-PAY` never reaches the model — same underlying bug the spec identified). `test_plan_requires_a_requirement_first`/`test_plan_creates_spec_document_against_latest_requirement`/etc. should now PASS already from Task 4's routing change (no more 409 for missing BYO) — if they don't, Task 4 wasn't applied correctly; fix that before continuing.

- [ ] **Step 3: Implement full-text injection**

In `apps/cloud/app/api/generation.py`, the current context-building block (lines 104-119):

```python
    context = ""
    if stage in ("specify", "plan") and conn.embed_model:
        # The M0 payoff: ground on the project's uploaded documents (and
        # every other embedded node type) via the same membership-scoped
        # retrieval assistant.chat uses. Skipped, not errored, when the
        # resolved connection can't embed (the managed tier is chat-only in
        # this pilot) — same "skip when ungrounded" shape the embed queue
        # uses for a missing BYO connection.
        [query_embedding] = await embedder.embed(
            [body.user_input], conn.embed_model, api_key, conn.base_url
        )
        hits = repo.vector_search(project.workspace_id, project_id, query_embedding, top_k=8)
        context = _assemble_retrieval_context(repo, project_id, hits)
    elif stage == "tasks":
        # tasks grounds on the approved plan, not raw uploads.
        context = f"[spec_documents:{spec.id}]\n{spec.content}"
```

Replace it with:

```python
    context = ""
    if stage in ("specify", "plan"):
        # Full-text injection, not embedding-retrieval (docs/superpowers/
        # specs/2026-07-25-cloud-planner-ui-design.md): a project realistically
        # has one or two PRD documents, so giving the model everything beats
        # top-8 semantic chunks for something plan-critical — and it works
        # with the managed (chat-only, no embed_model) connection, unlike the
        # retrieval path it replaces.
        context = _assemble_document_context(repo.list_documents(project_id))
    elif stage == "tasks":
        # tasks grounds on the approved plan, not raw uploads.
        context = f"[spec_documents:{spec.id}]\n{spec.content}"
```

Replace the now-unused `_assemble_retrieval_context` helper (lines 204-213) with a new one — same location:

```python
# Total characters of document text injected into a single specify/plan
# prompt. Mirrors the budget-capping shape of apps/engine's repoSnapshot()
# (apps/engine/src/routes/projects.ts) — same problem (bound an LLM prompt
# by a fixed character budget across N files), same "truncate the tail, note
# it was truncated" approach.
_DOCUMENT_CONTEXT_BUDGET = 40_000


def _assemble_document_context(documents: list) -> str:
    parts = []
    budget = _DOCUMENT_CONTEXT_BUDGET
    for doc in documents:
        if not doc.extracted_text:
            continue
        if budget <= 0:
            parts.append("(remaining documents omitted — context budget reached)")
            break
        text = doc.extracted_text[:budget]
        budget -= len(text)
        parts.append(f"[document:{doc.title}]\n{text}")
    return "\n\n".join(parts)
```

Since `embedder`/`api_key`-for-embedding are no longer used by this branch, check whether `embedder = getattr(request.app.state, "embedding_provider", None) or HttpEmbeddingProvider()` (line 101) is still referenced anywhere else in `generate()` — it isn't (grep the function body) — delete that now-dead line too. Leave `HttpEmbeddingProvider` imported at the top only if something else in the file still uses it (check — if this was the only use, remove that import line as well).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/cloud && python -m pytest tests/test_generation.py -v`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Run the full cloud suite**

Run: `cd apps/cloud && python -m pytest -v 2>&1 | tail -40`
Expected: every test file green (this closes out the gap Task 4 Step 5 flagged).

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/app/api/generation.py apps/cloud/tests/test_generation.py
git commit -m "feat(cloud): full-text PRD injection for specify/plan (fixes dead RAG path with managed Typhoon)"
```

---

## Task 6: Remove `ModelSourcePanel` from the web app

**Files:**
- Delete: `apps/web/src/components/ModelSourcePanel.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/settings/page.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx`
- Modify: `apps/web/src/lib/types.ts` (remove now-unused `RoutingTable`/`EffectiveStageRouting`/`ModelSource` types, lines 158-171 area — keep `StageKind`, it's reused by Task 8's Planner component)

**Interfaces:**
- No new interfaces — this task only removes dead UI now that Task 4 deleted the routing API it called.

- [ ] **Step 1: Delete the component and its route-level usage**

```bash
rm apps/web/src/components/ModelSourcePanel.tsx
```

In `apps/web/src/app/w/[workspaceId]/settings/page.tsx`, remove the import (line 5) and the `<ModelSourcePanel .../>` usage (line 37):

```tsx
import { ModelSourcePanel } from "@/components/ModelSourcePanel";
```
— delete this line.

```tsx
        <ModelSourcePanel scope="workspace" id={workspaceId} isAdmin={isAdmin} />
```
— delete this line. If `isAdmin` becomes unused elsewhere in the file after this removal, leave it (it's still computed the same way and is harmless/likely to be needed again once B/C settings land) — do not remove the `isAdmin` computation itself, only the panel.

In `apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx`, same pattern — remove the import (line 5) and the usage (line 44):

```tsx
import { ModelSourcePanel } from "@/components/ModelSourcePanel";
```
— delete.

```tsx
        <ModelSourcePanel scope="project" id={projectId} isAdmin={isAdmin} />
```
— delete.

- [ ] **Step 2: Remove now-dead types**

In `apps/web/src/lib/types.ts`, lines 157-171 currently read:

```ts
// Stage routing (M3, plan 0007) — see apps/cloud/app/api/routing.py.
export type StageKind = "constitution" | "specify" | "plan" | "tasks";
export type ModelSource = "byo" | "managed";
export type RoutingOrigin = "project" | "workspace" | "default";

export interface EffectiveStageRouting {
  stage: StageKind;
  model_source: ModelSource;
  model: string | null;
  origin: RoutingOrigin;
}

export interface RoutingTable {
  routing: EffectiveStageRouting[];
}
```

`ModelSource`, `RoutingOrigin`, `EffectiveStageRouting`, and `RoutingTable` were only consumed by `ModelSourcePanel.tsx` (now deleted) — remove them and the stale comment, keeping only `StageKind` (Task 10's Planner component reuses it):

```ts
export type StageKind = "constitution" | "specify" | "plan" | "tasks";
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors. If either settings page now has an unused `isAdmin` variable flagged by a lint rule (not `tsc`, which doesn't flag unused vars by default in this config — but check), that's fine per Step 1's note; don't remove it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/w/[workspaceId]/settings/page.tsx apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx apps/web/src/lib/types.ts
git rm apps/web/src/components/ModelSourcePanel.tsx
git commit -m "chore(web): remove ModelSourcePanel (dead after Planner BYO removal)"
```

---

## Task 7: Web types + `apiFetch`-based document upload and generation helpers

**Files:**
- Modify: `apps/web/src/lib/types.ts` (add `Project` lifecycle fields, `GenerateEvent`, `DocumentOut` types)
- Test: `apps/web/src/lib/planner-sse.test.ts` (new)
- Create: `apps/web/src/lib/planner-sse.ts` (new — the SSE line-parser, extracted as a pure function so it's testable without a real network stream)

**Interfaces:**
- Produces: `parseSseLine(line: string, state: SseParseState) -> SseParseState` and `type SseParseState = { event: "message" | "done" | "error"; data: unknown } | null` — Task 8's Planner component's `useStageGeneration` hook consumes this exact function.
- Produces: `Project` type gains `lifecycle_status: "planning" | "pending_tech_review" | "tech_review" | "repo_created"`, `repo_url: string | null`, `repo_default_branch: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/planner-sse.test.ts
import { describe, expect, it } from "vitest";
import { parseSseLine, type SseParseState } from "./planner-sse";

describe("parseSseLine", () => {
  it("parses a bare data line as a message-event delta", () => {
    let state: SseParseState = null;
    state = parseSseLine('data: {"delta":"hello"}', state);
    expect(state).toEqual({ event: "message", data: { delta: "hello" } });
  });

  it("parses an event: line followed by a data: line as that event type", () => {
    let state: SseParseState = null;
    state = parseSseLine("event: done", state);
    state = parseSseLine('data: {"stage":"specify","content":"# Spec"}', state);
    expect(state).toEqual({
      event: "done",
      data: { stage: "specify", content: "# Spec" },
    });
  });

  it("parses an error event", () => {
    let state: SseParseState = null;
    state = parseSseLine("event: error", state);
    state = parseSseLine('data: {"error":"boom","retryable":true}', state);
    expect(state).toEqual({ event: "error", data: { error: "boom", retryable: true } });
  });

  it("returns the previous state unchanged for a blank line (frame separator)", () => {
    let state: SseParseState = null;
    state = parseSseLine('data: {"delta":"a"}', state);
    const before = state;
    state = parseSseLine("", state);
    expect(state).toEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/planner-sse.test.ts`
Expected: FAIL — `Cannot find module './planner-sse'`

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/planner-sse.ts
//
// Parses the backend's SSE framing (apps/cloud/app/api/generation.py::stream):
// a bare "data: {...}" line is a "message" event (a streamed delta chunk);
// an "event: done"/"event: error" line followed by "data: {...}" is that
// named terminal event. One line in, current parse state out — a pure
// function so it's testable without a real fetch/ReadableStream.

export type SseParseState = { event: "message" | "done" | "error"; data: unknown } | null;

export function parseSseLine(line: string, prev: SseParseState): SseParseState {
  if (line.startsWith("event:")) {
    const event = line.slice("event:".length).trim();
    if (event === "done" || event === "error") {
      return { event, data: prev?.data ?? null };
    }
    return prev;
  }
  if (line.startsWith("data:")) {
    const raw = line.slice("data:".length).trim();
    if (!raw) return prev;
    const data = JSON.parse(raw);
    // A bare data: line with no preceding event: line this frame is a
    // "message" (delta) event, per the backend's framing.
    const event = prev && prev.event !== "message" ? prev.event : "message";
    return { event, data };
  }
  return prev;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/planner-sse.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Add the new `Project` fields and document/generation types**

In `apps/web/src/lib/types.ts`, lines 31-40 currently read:

```ts
export interface Project {
  id: string;
  name: string;
  workspace_id: string;
  owner_id: string;
  onboarding_state: string;
  stage_state: Record<string, string>;
  created_at: string;
  updated_at: string;
}
```

Change to:

```ts
export interface Project {
  id: string;
  name: string;
  workspace_id: string;
  owner_id: string;
  onboarding_state: string;
  stage_state: Record<string, string>;
  lifecycle_status: "planning" | "pending_tech_review" | "tech_review" | "repo_created";
  repo_url: string | null;
  repo_default_branch: string | null;
  created_at: string;
  updated_at: string;
}
```

Add new types for the Planner (near the kept `StageKind`):

```ts
export interface DocumentOut {
  id: string;
  project_id: string;
  title: string;
  mime: string;
  source_kind: string;
  extract_method: string | null;
  status: "pending" | "extracted" | "failed";
  created_at: string;
  updated_at: string;
}

export interface GenerateDoneEvent {
  stage: StageKind;
  title: string;
  content: string;
  requirement_id?: string;
  spec_document_id?: string;
  task_count?: number;
}

export interface GenerateErrorEvent {
  error: string;
  retryable?: boolean;
}
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/planner-sse.ts apps/web/src/lib/planner-sse.test.ts apps/web/src/lib/types.ts
git commit -m "feat(web): SSE frame parser + Planner/lifecycle types"
```

---

## Task 8: `DocumentUpload` component

**Files:**
- Create: `apps/web/src/components/project/DocumentUpload.tsx`
- Test: `apps/web/src/components/project/DocumentUpload.test.tsx` (new)

**Interfaces:**
- Consumes: `CLOUD_API_URL` (`apps/web/src/lib/config.ts`), `useAuth` (`apps/web/src/lib/auth.ts`), `DocumentOut` type from Task 7. (Raw `fetch`, not `apiFetch` — this is a multipart upload, `apiFetch` always sets `content-type: application/json`.)
- Produces: `DocumentUpload({ projectId, onUploaded }: { projectId: string; onUploaded: (doc: DocumentOut) => void })` — Task 10's `Planner` component renders this and passes a callback to refresh its document list.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/project/DocumentUpload.test.tsx
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentUpload } from "./DocumentUpload";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;

describe("DocumentUpload", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("uploads a selected file and reports the result", async () => {
    const onUploaded = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "doc-1",
        project_id: "p1",
        title: "prd.md",
        mime: "text/markdown",
        source_kind: "upload",
        extract_method: "passthrough",
        status: "extracted",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    }) as unknown as typeof fetch;

    render(<DocumentUpload projectId="p1" onUploaded={onUploaded} />);

    const file = new File(["# PRD"], "prd.md", { type: "text/markdown" });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: "doc-1", status: "extracted" }));
  });

  it("shows an error banner when extraction fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "doc-2",
        project_id: "p1",
        title: "scan.pdf",
        mime: "application/pdf",
        source_kind: "upload",
        extract_method: null,
        status: "failed",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    }) as unknown as typeof fetch;

    render(<DocumentUpload projectId="p1" onUploaded={vi.fn()} />);

    const file = new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/upload/i) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(screen.getByText(/couldn't read this file/i)).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/project/DocumentUpload.test.tsx`
Expected: FAIL — `Cannot find module './DocumentUpload'`

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/project/DocumentUpload.tsx
"use client";

import { useState } from "react";
import { CLOUD_API_URL } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import type { DocumentOut } from "@/lib/types";

// Direct fetch, not apiFetch: this is a multipart upload, not JSON — apiFetch
// always sets content-type: application/json, which would break the
// boundary-encoded body. Mirrors apps/cloud/app/api/documents.py's
// ALLOWED_MIMES exactly so the browser's file picker only offers files the
// server will actually accept.
const ACCEPTED_MIME = "text/markdown,text/plain,application/pdf";

export function DocumentUpload({
  projectId,
  onUploaded,
}: {
  projectId: string;
  onUploaded: (doc: DocumentOut) => void;
}) {
  const { authHeaders } = useAuth();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/documents`, {
        method: "POST",
        headers: authHeaders(),
        body,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { detail?: string }).detail ?? `upload failed (${res.status})`);
      }
      const doc = (await res.json()) as DocumentOut;
      if (doc.status === "failed") {
        setError("Couldn't read this file — try a text-based export (not a scanned image).");
      }
      onUploaded(doc);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-4">
      <label className="flex cursor-pointer items-center justify-center gap-2 text-sm text-slate-600">
        <input
          type="file"
          accept={ACCEPTED_MIME}
          onChange={handleChange}
          disabled={uploading}
          className="sr-only"
        />
        {uploading ? "Uploading…" : "Upload a PRD (PDF or Markdown)"}
      </label>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/project/DocumentUpload.test.tsx`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/project/DocumentUpload.tsx apps/web/src/components/project/DocumentUpload.test.tsx
git commit -m "feat(web): DocumentUpload component for the Planner"
```

---

## Task 9: `useStageGeneration` hook (SSE-driven stage generation)

**Files:**
- Create: `apps/web/src/components/project/useStageGeneration.ts`
- Test: `apps/web/src/components/project/useStageGeneration.test.ts` (new)

**Interfaces:**
- Consumes: `parseSseLine`/`SseParseState` from Task 7, `useAuth` (`apps/web/src/lib/auth.ts`), `CLOUD_API_URL` (`apps/web/src/lib/config.ts`).
- Produces: `useStageGeneration(projectId: string) -> { status: "idle" | "generating" | "done" | "error"; streamedText: string; result: GenerateDoneEvent | null; error: GenerateErrorEvent | null; generate: (stage: StageKind, userInput: string) => Promise<void> }` — Task 10's `Planner` component calls `generate()` per stage and renders `streamedText`/`status`/`error`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/project/useStageGeneration.test.ts
import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStageGeneration } from "./useStageGeneration";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const originalFetch = global.fetch;

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
}

describe("useStageGeneration", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("accumulates delta text while streaming, then resolves with the done payload", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        'data: {"delta":"Hello "}',
        'data: {"delta":"world"}',
        "event: done",
        'data: {"stage":"specify","title":"T","content":"Hello world","requirement_id":"r1"}',
      ]),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useStageGeneration("p1"));

    await act(async () => {
      await result.current.generate("specify", "do the thing");
    });

    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.streamedText).toBe("Hello world");
    expect(result.current.result?.requirement_id).toBe("r1");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a structured error event without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        "event: error",
        'data: {"error":"managed tier busy, try again","retryable":true}',
      ]),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useStageGeneration("p1"));

    await act(async () => {
      await result.current.generate("plan", "plan it");
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.retryable).toBe(true);
    expect(result.current.error?.error).toMatch(/managed tier busy/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/project/useStageGeneration.test.ts`
Expected: FAIL — `Cannot find module './useStageGeneration'`

- [ ] **Step 3: Implement**

```ts
// apps/web/src/components/project/useStageGeneration.ts
"use client";

import { useCallback, useState } from "react";
import { CLOUD_API_URL } from "@/lib/config";
import { useAuth } from "@/lib/auth";
import { parseSseLine, type SseParseState } from "@/lib/planner-sse";
import type { GenerateDoneEvent, GenerateErrorEvent, StageKind } from "@/lib/types";

type Status = "idle" | "generating" | "done" | "error";

export function useStageGeneration(projectId: string) {
  const { authHeaders } = useAuth();
  const [status, setStatus] = useState<Status>("idle");
  const [streamedText, setStreamedText] = useState("");
  const [result, setResult] = useState<GenerateDoneEvent | null>(null);
  const [error, setError] = useState<GenerateErrorEvent | null>(null);

  const generate = useCallback(
    async (stage: StageKind, userInput: string) => {
      setStatus("generating");
      setStreamedText("");
      setResult(null);
      setError(null);

      const res = await fetch(`${CLOUD_API_URL}/projects/${projectId}/generate/${stage}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ user_input: userInput }),
      });

      if (!res.ok || !res.body) {
        setStatus("error");
        setError({ error: `request failed (${res.status})` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let state: SseParseState = null;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          state = parseSseLine(line, state);
          if (state?.event === "message") {
            const delta = (state.data as { delta?: string }).delta;
            if (delta) setStreamedText((prev) => prev + delta);
          }
        }
      }

      if (state?.event === "done") {
        setResult(state.data as GenerateDoneEvent);
        setStatus("done");
      } else if (state?.event === "error") {
        setError(state.data as GenerateErrorEvent);
        setStatus("error");
      } else {
        setStatus("error");
        setError({ error: "stream ended with no result" });
      }
    },
    [projectId, authHeaders],
  );

  return { status, streamedText, result, error, generate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/project/useStageGeneration.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/project/useStageGeneration.ts apps/web/src/components/project/useStageGeneration.test.ts
git commit -m "feat(web): useStageGeneration hook (SSE-streamed Spec Kit stage calls)"
```

---

## Task 10: `Planner` component (stage stepper) + `submit-for-review` action

**Files:**
- Create: `apps/web/src/components/project/Planner.tsx`
- Test: `apps/web/src/components/project/Planner.test.tsx` (new)

**Interfaces:**
- Consumes: `DocumentUpload` (Task 8), `useStageGeneration` (Task 9), `useCloudGet`/`apiFetch` (existing), `Project`/`DocumentOut`/`StageKind` types (Task 7).
- Produces: `Planner({ project, projectId, onChange }: { project: Project; projectId: string; onChange: () => void })` — Task 11 wires this into the project page's `TABS`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/project/Planner.test.tsx
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Planner } from "./Planner";
import type { Project } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    owner_id: "u1",
    lifecycle_status: "planning",
    repo_url: null,
    repo_default_branch: null,
    ...overrides,
  } as Project;
}

describe("Planner", () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as unknown as typeof fetch;
  });

  it("renders the document upload and stage stepper for a planning-stage project", () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(screen.getByText(/upload a prd/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
  });

  it("shows a read-only notice instead of the stepper once past planning", () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "pending_tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/sent to tech lead/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate specification/i })).not.toBeInTheDocument();
  });
});
```

(Restore `global.fetch = originalFetch` isn't strictly required per-test here since every test in this file sets its own mock in `beforeEach`, but do it in `afterEach` for hygiene, matching Task 8/9's pattern — add `afterEach(() => { global.fetch = originalFetch; localStorage.clear(); });` alongside the `beforeEach` above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/project/Planner.test.tsx`
Expected: FAIL — `Cannot find module './Planner'`

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/project/Planner.tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentUpload } from "./DocumentUpload";
import { useStageGeneration } from "./useStageGeneration";
import type { DocumentOut, Project, StageKind } from "@/lib/types";

const STAGE_ORDER: { stage: StageKind; label: string; buttonLabel: string }[] = [
  { stage: "specify", label: "Specify", buttonLabel: "Generate specification" },
  { stage: "plan", label: "Plan", buttonLabel: "Generate plan" },
  { stage: "tasks", label: "Tasks", buttonLabel: "Generate tasks" },
];

// One stepper section: an input for the business framing, a Generate
// button, and the live-streamed output. Each stage is independent state —
// there's no cross-stage gating in this sub-project (no approval concept
// yet, see the design doc's "No approval gate in this sub-project").
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
  const [input, setInput] = useState("");
  const { status, streamedText, result, error, generate } = useStageGeneration(projectId);

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

      {(status === "generating" || status === "done") && streamedText && (
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
    </div>
  );
}

export function Planner({
  project,
  projectId,
  onChange,
}: {
  project: Project;
  projectId: string;
  onChange: () => void;
}) {
  const { authHeaders } = useAuth();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (project.lifecycle_status !== "planning") {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
        This project has been sent to Tech Lead review — planning is read-only from here.
      </div>
    );
  }

  async function submitForReview() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch(`/projects/${projectId}/lifecycle/submit-for-review`, authHeaders(), {
        method: "POST",
      });
      onChange();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <DocumentUpload projectId={projectId} onUploaded={(doc) => setDocuments((prev) => [...prev, doc])} />
      {documents.length > 0 && (
        <ul className="text-xs text-slate-500">
          {documents.map((d) => (
            <li key={d.id}>
              {d.title} — {d.status}
              {d.status === "failed" && " (couldn't extract text — try a text-based export)"}
            </li>
          ))}
        </ul>
      )}

      {STAGE_ORDER.map(({ stage, label, buttonLabel }) => (
        <StageSection key={stage} projectId={projectId} stage={stage} label={label} buttonLabel={buttonLabel} />
      ))}

      <div className="border-t border-slate-200 pt-4">
        <button
          type="button"
          disabled={submitting}
          onClick={submitForReview}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Send to Tech Lead"}
        </button>
        {submitError && <p className="mt-2 text-sm text-red-600">{submitError}</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/project/Planner.test.tsx`
Expected: PASS (both tests)

- [ ] **Step 5: Typecheck the whole app**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/project/Planner.tsx apps/web/src/components/project/Planner.test.tsx
git commit -m "feat(web): Planner component (upload + stage stepper + submit-for-review)"
```

---

## Task 11: Wire the Planner tab into the project page

**Files:**
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx`

**Interfaces:**
- Consumes: `Planner` from Task 10, `ProjectGraph.project: Project` (existing — `graph.project` already carries the lifecycle fields once Task 1's schema change round-trips through `GET /sync/projects/{id}/graph`, since that endpoint's `response_model=ProjectGraph` nests the same `Project` model).

- [ ] **Step 1: Edit `TABS` and imports**

Current (lines 1-16):

```tsx
"use client";

import Link from "next/link";
import { use, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { PresenceBar } from "@/components/PresenceBar";
import { GraphBrowser } from "@/components/project/GraphBrowser";
import { TaskBoard } from "@/components/project/TaskBoard";
import { ProgressRollup } from "@/components/project/ProgressRollup";
import { DiscussionThread } from "@/components/project/DiscussionThread";
import { useCloudGet } from "@/lib/hooks";
import type { ProjectGraph } from "@/lib/types";

const TABS = ["Graph", "Tasks", "Progress", "Discussion"] as const;
type Tab = (typeof TABS)[number];
```

Change to:

```tsx
"use client";

import Link from "next/link";
import { use, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { PresenceBar } from "@/components/PresenceBar";
import { GraphBrowser } from "@/components/project/GraphBrowser";
import { Planner } from "@/components/project/Planner";
import { TaskBoard } from "@/components/project/TaskBoard";
import { ProgressRollup } from "@/components/project/ProgressRollup";
import { DiscussionThread } from "@/components/project/DiscussionThread";
import { useCloudGet } from "@/lib/hooks";
import type { ProjectGraph } from "@/lib/types";

const TABS = ["Planner", "Graph", "Tasks", "Progress", "Discussion"] as const;
type Tab = (typeof TABS)[number];
```

- [ ] **Step 2: Default to the Planner tab and add its render branch**

Current (line 19 and lines 63-74):

```tsx
  const [tab, setTab] = useState<Tab>("Graph");
```

```tsx
        {graph && (
          <>
            {tab === "Graph" && <GraphBrowser graph={graph} />}
            {tab === "Tasks" && (
              <TaskBoard graph={graph} workspaceId={workspaceId} projectId={projectId} onChange={refetch} />
            )}
            {tab === "Progress" && <ProgressRollup graph={graph} />}
            {tab === "Discussion" && (
              <DiscussionThread graph={graph} projectId={projectId} onPosted={refetch} />
            )}
          </>
        )}
```

Change to:

```tsx
  const [tab, setTab] = useState<Tab>("Planner");
```

```tsx
        {graph && (
          <>
            {tab === "Planner" && (
              <Planner project={graph.project} projectId={projectId} onChange={refetch} />
            )}
            {tab === "Graph" && <GraphBrowser graph={graph} />}
            {tab === "Tasks" && (
              <TaskBoard graph={graph} workspaceId={workspaceId} projectId={projectId} onChange={refetch} />
            )}
            {tab === "Progress" && <ProgressRollup graph={graph} />}
            {tab === "Discussion" && (
              <DiscussionThread graph={graph} projectId={projectId} onPosted={refetch} />
            )}
          </>
        )}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual check**

Run: `pnpm cloud` (separate terminal) + `pnpm web`, sign in, open any existing project, confirm the "Planner" tab appears first and is selected by default, and that switching to Graph/Tasks/Progress/Discussion still works exactly as before.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx"
git commit -m "feat(web): add Planner tab to the project page"
```

---

## Task 12: New Project creation on the workspace page

**Files:**
- Modify: `apps/web/src/app/w/[workspaceId]/page.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `useAuth` (existing), `Project` type (Task 7).

- [ ] **Step 1: Add the create-project form**

Current empty-state block (lines 101-125) and header (lines 78-99) — add a "New Project" button next to the existing Members/Settings links, and a small inline form. Add these imports (alongside the existing ones at the top of the file):

```tsx
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
```

(`useState` may need merging into the existing `import { use, useEffect } from "react";` line — change it to `import { use, useEffect, useState } from "react";`.)

Inside `WorkspaceHome`, after the existing `useCloudGet` calls (after line 59), add:

```tsx
  const { authHeaders } = useAuth();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  async function createProject() {
    if (!newName.trim()) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const project = await apiFetch<Project>("/projects", authHeaders(), {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), workspace_id: workspaceId }),
      });
      setNewName("");
      setCreating(false);
      router.push(`/w/${workspaceId}/p/${project.id}`);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  }
```

In the header's button group (currently the `<div className="flex items-center gap-2">...</div>` around lines 82-98), add a "New Project" button before the existing Members link:

```tsx
          <div className="flex items-center gap-2">
            {creating ? (
              <span className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") createProject();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder="Project name"
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={createBusy || !newName.trim()}
                  onClick={createProject}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-60"
                >
                  Add
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
              >
                + New project
              </button>
            )}
            <Link
              href={`/w/${workspaceId}/members`}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300"
            >
              {members && members.length > 0 && <MemberStack members={members} />}
              <span className="text-sm text-slate-500">
                {members?.length ?? 0} {members?.length === 1 ? "member" : "members"}
              </span>
            </Link>
            <Link
              href={`/w/${workspaceId}/settings`}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
            >
              Settings
            </Link>
          </div>
```

If `createError` is set, render it right below the header div (after the closing `</div>` of the `mb-8 flex items-start justify-between gap-4` container, before the `<h2>Projects</h2>` line):

```tsx
        {createError && <p className="mb-4 text-sm text-red-600">{createError}</p>}
```

Also update the empty-state copy (lines 104-110), which currently says "link one from the desktop app" — that's no longer the only path:

```tsx
        {!loading && (projects?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              No projects yet. Create one above, or link one from the desktop app.
            </p>
          </div>
        ) : (
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual check**

Run: `pnpm cloud` + `pnpm web`, sign in, open a workspace, click "+ New project", type a name, confirm it navigates to the new project's page with the Planner tab active and no projects.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/w/[workspaceId]/page.tsx"
git commit -m "feat(web): New Project creation on the workspace page"
```

---

## Task 13: Engine roster — carry lifecycle fields

**Files:**
- Modify: `apps/engine/src/cloudClient.ts` (`RosterProject` type ~line 78, `refreshRoster`'s mapping ~in `apps/engine/src/routes/cloud.ts:124-159`)

**Interfaces:**
- Produces: `RosterProject` gains `lifecycle_status: string`, `repo_url: string | null`, `repo_default_branch: string | null` — this is the exact seam sub-project D (desktop clone-detection) reads from; this task only carries the data through, no UI change.

- [ ] **Step 1: Write the failing test**

```ts
// apps/engine/test/roster-lifecycle.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeRoster, loadRosterProjects, type RosterProject } from "../src/cloudClient.ts";

test("RosterProject round-trips lifecycle_status/repo_url/repo_default_branch through storeRoster/loadRosterProjects", () => {
  const project: RosterProject = {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    lifecycle_status: "repo_created",
    repo_url: "https://github.com/acme/p1",
    repo_default_branch: "main",
  };
  storeRoster([], [project]);
  const loaded = loadRosterProjects();
  assert.deepEqual(loaded, [project]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/engine && node --test test/roster-lifecycle.test.ts`
Expected: FAIL — TypeScript type error at the object literal (`lifecycle_status`/`repo_url`/`repo_default_branch` don't exist on `RosterProject` yet) surfaces as a runtime failure once Node's strip-only TS mode hits it, or the assertion fails because `loaded` only has `{id, name, workspace_id}` — either way, RED.

- [ ] **Step 3: Implement**

In `apps/engine/src/cloudClient.ts`, the current type (line 78):

```ts
export type RosterProject = { id: string; name: string; workspace_id: string };
```

Change to:

```ts
export type RosterProject = {
  id: string;
  name: string;
  workspace_id: string;
  // Cloud Planner lifecycle (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md):
  // planning -> pending_tech_review -> tech_review -> repo_created. Desktop
  // reads these to decide whether a roster project with no local counterpart
  // yet is "clone this repo" (repo_url set) vs. still being planned.
  lifecycle_status: string;
  repo_url: string | null;
  repo_default_branch: string | null;
};
```

In `apps/engine/src/routes/cloud.ts`, find the `refreshRoster` mapping (~lines 124-159, the excerpt from exploration):

```ts
    const rawProjects = await cloudFetch<{ id: string; name: string; workspace_id: string }[]>("/projects");
    const projects: RosterProject[] = rawProjects.map((p) => ({ id: p.id, name: p.name, workspace_id: p.workspace_id }));
    storeRoster(workspaces, projects);
```

Change to:

```ts
    const rawProjects = await cloudFetch<
      {
        id: string;
        name: string;
        workspace_id: string;
        lifecycle_status: string;
        repo_url: string | null;
        repo_default_branch: string | null;
      }[]
    >("/projects");
    const projects: RosterProject[] = rawProjects.map((p) => ({
      id: p.id,
      name: p.name,
      workspace_id: p.workspace_id,
      lifecycle_status: p.lifecycle_status,
      repo_url: p.repo_url,
      repo_default_branch: p.repo_default_branch,
    }));
    storeRoster(workspaces, projects);
```

(Read the exact surrounding code first — the exploration excerpt may have trimmed context; match indentation/brace style to what's actually there.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/engine && node --test test/roster-lifecycle.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full engine test suite**

Run: `cd apps/engine && node --test test/*.test.ts`
Expected: all green, no regressions (this is an additive type change — `apps/desktop/src/components/Workspace.tsx`'s existing roster-reading code only destructures `workspace_id`/`name`, confirmed safe to extend during Task 13's investigation).

- [ ] **Step 6: Commit**

```bash
git add apps/engine/src/cloudClient.ts apps/engine/src/routes/cloud.ts apps/engine/test/roster-lifecycle.test.ts
git commit -m "feat(engine): carry lifecycle_status/repo_url/repo_default_branch in the roster cache"
```

---

## Task 14: Full-stack manual verification

**Files:** none — verification only.

- [ ] **Step 1: Run every automated suite**

```bash
cd apps/cloud && python -m pytest -v
cd apps/web && npx vitest run && npx tsc --noEmit
cd apps/engine && node --test test/*.test.ts
```

Expected: all green.

- [ ] **Step 2: Manual end-to-end walkthrough**

Start `pnpm cloud` (or `uvicorn app.main:app --reload --port 8080 --env-file=.env.local` per `apps/cloud`'s README) and `pnpm web`. As a business user with no BYO model connected anywhere:

1. Sign in, create a workspace (or use an existing one), click "+ New project", name it, confirm it lands on the new project's page with the Planner tab active.
2. Upload a real PDF or Markdown PRD via the Planner tab's upload widget — confirm it shows `extracted` status (not `failed`, unless you deliberately test a scanned/image-only PDF, which should show the "couldn't read this file" message).
3. Generate Specify — confirm the streamed output visibly reflects a fact that's only in the uploaded PRD (proves full-text injection, not just that generation runs).
4. Generate Plan, then Tasks — confirm both succeed with no BYO-connection error anywhere (the whole point of Task 4).
5. Click "Send to Tech Lead" — confirm no error, and that revisiting the Planner tab now shows the read-only "sent to tech lead" notice instead of the stepper.
6. Confirm `GET /projects` (e.g. via the browser devtools network tab, or `curl -H "X-User-Id: <your-id>" http://localhost:8080/projects`) includes `"lifecycle_status": "pending_tech_review"` for this project.

- [ ] **Step 3: Confirm no regression in Settings pages**

Visit both `/w/{workspaceId}/settings` and `/w/{workspaceId}/p/{projectId}/settings` — confirm they render without error and no longer show a "Model source" panel.
