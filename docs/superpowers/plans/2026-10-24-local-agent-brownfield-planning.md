# Local Agent Brownfield Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An imported project's baseline and four stage documents are drafted by the importer's local coding agent through three new MCP tools, land in the cloud as pending drafts, and are accepted or rejected in the web Planner through the existing `apply_stage_content` path.

**Architecture:** Cloud gains one service-only table (`pw_stage_drafts`), a provenance column on `pw_repo_analyses` and `pw_stage_documents`, and six routes in two routers (`repo_analysis.py` gets the agent write; a new `stage_drafts.py` owns brief, submit, list, accept, reject). `apps/mcp` gains three synchronous tools over three new `CloudClient` methods. `apps/web` swaps the Analyze button for a checklist on imported projects, hides Generate and Prefill for them, and adds a draft banner above each stage editor.

**Tech Stack:** FastAPI + Pydantic v2 + pytest (cloud); TypeScript + `@modelcontextprotocol/sdk` + `node:test` (mcp, cloud-client); Next.js 16 + React 19 + vitest (web); Postgres migration SQL.

**Spec:** `docs/superpowers/specs/2026-10-24-local-agent-brownfield-planning-design.md`

## Global Constraints

- Tables are `pw_*`. Next migration file is `apps/cloud/migrations/0012_pw_stage_drafts.sql` (0011 went to plan 0033's workspace governance); check the directory before claiming the number.
- New table is born service-only: RLS enabled with no policy, `revoke all ... from authenticated` and `from anon`, `grant select, insert, update, delete ... to service_role`, name added to `_SERVICE_ONLY_TABLES` in `apps/cloud/app/db/supabase_repository.py`.
- Stage kinds stay `constitution | specify | plan | tasks`. No renames.
- Per-stage access is `require_stage_access(repo, project, stage, user)` from `app/api/_guards.py`; baseline writes are `require_admin`.
- Draft and baseline markdown cap is 100,000 characters, refused with HTTP 413.
- `MAX_PATHS = 2_000` from `app/imports/snapshot.py`; received paths go through `filter_paths` server-side.
- All three MCP tools are synchronous; none touches `StatusQueue`.
- MCP server never calls `PUT /sync/projects/{id}/graph` and adds no claim tool.
- Commits: scoped Conventional Commits, e.g. `feat(cloud): ...`, `feat(mcp): ...`, `feat(web): ...`, `docs: ...`.
- Cloud verification: `cd apps/cloud && pytest && ruff check .`. MCP: `pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp test`. Cloud-client: `pnpm --dir packages/cloud-client test`. Web: `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`.

## Review Focus

1. Agent submits a `paths` list containing `.env` or `keys/deploy.pem`; stored snapshot must not list them. Test in Task 2.
2. Accept on `plan` when no requirement exists must return 409 before any document is saved. Test in Task 4.
3. Accept whose projection returns `failed` must keep the draft pending with `last_error`, not delete it. Test in Task 4.
4. A member calling `submit_stage_draft` for `constitution` gets the same 403 detail the generate route gives, and the MCP tool reports it as a tool error naming the stage. Tests in Tasks 4 and 6.
5. A resubmission for a stage with a pending draft replaces it and clears `last_error` and `status = rejected`. Test in Task 4.

---

### Task 1: Schema, migration and repository for drafts and provenance

**Files:**
- Create: `apps/cloud/migrations/0011_pw_stage_drafts.sql`
- Modify: `apps/cloud/app/models/schemas.py` (after `RepoAnalysis`, after `StageDocument`)
- Modify: `apps/cloud/app/db/repository.py` (abstract `Repository` near line 860; `InMemoryRepository` near line 2056)
- Modify: `apps/cloud/app/db/supabase_repository.py` (`_SERVICE_ONLY_TABLES` line 182; impl near line 1955)
- Test: `apps/cloud/tests/test_stage_drafts_repo.py`

**Interfaces:**
- Produces:
  ```python
  DraftSource = Literal["agent"]
  StageDraftStatus = Literal["pending", "rejected"]

  class StageDraft(BaseModel):
      id: str = Field(default_factory=new_id)
      project_id: str
      workspace_id: str
      stage: Literal["constitution", "specify", "plan", "tasks"]
      markdown: str
      source: DraftSource = "agent"
      model: str | None = None
      status: StageDraftStatus = "pending"
      rejection_note: str | None = None
      last_error: str | None = None
      created_by: str
      created_at: datetime = Field(default_factory=utcnow)

  # RepoAnalysis gains:  source: Literal["cloud", "agent"] = "cloud";  model: str | None = None
  # StageDocument gains: source: Literal["generated", "manual", "agent"] | None = None

  # Repository ABC:
  def get_stage_draft(self, project_id: str, stage: str) -> StageDraft | None: ...
  def list_stage_drafts(self, project_id: str) -> list[StageDraft]: ...
  def upsert_stage_draft(self, draft: StageDraft) -> StageDraft: ...   # one row per (project, stage); replaces
  def delete_stage_draft(self, project_id: str, stage: str) -> bool: ...
  ```

- [ ] **Step 1: Write the failing repository tests**

```python
# apps/cloud/tests/test_stage_drafts_repo.py
def test_upsert_replaces_the_pending_draft_for_a_stage(memory_repo, project):
    first = memory_repo.upsert_stage_draft(StageDraft(project_id=project.id, workspace_id=project.workspace_id, stage="specify", markdown="# v1", created_by="alice"))
    second = memory_repo.upsert_stage_draft(StageDraft(project_id=project.id, workspace_id=project.workspace_id, stage="specify", markdown="# v2", created_by="alice", status="rejected", rejection_note="no"))
    assert memory_repo.get_stage_draft(project.id, "specify").markdown == "# v2"
    assert len(memory_repo.list_stage_drafts(project.id)) == 1
    assert second.id != first.id

def test_delete_returns_whether_a_draft_existed(memory_repo, project):
    assert memory_repo.delete_stage_draft(project.id, "plan") is False
    memory_repo.upsert_stage_draft(StageDraft(project_id=project.id, workspace_id=project.workspace_id, stage="plan", markdown="# p", created_by="alice"))
    assert memory_repo.delete_stage_draft(project.id, "plan") is True

def test_repo_analysis_defaults_to_cloud_source():
    assert RepoAnalysis(project_id="p", workspace_id="w", commit_sha="c", snapshot=RepoSnapshot(commit_sha="c", default_branch="main"), created_by="a").source == "cloud"
```

Reuse the `memory_repo` / project fixture pattern from `tests/test_stage_documents_repo.py`.

- [ ] **Step 2: Run tests, expect ImportError on `StageDraft`**

Run: `cd apps/cloud && pytest tests/test_stage_drafts_repo.py -v`

- [ ] **Step 3: Add the models to `schemas.py`, the four methods to `Repository` and `InMemoryRepository` (dict keyed `(project_id, stage)`), and to `SupabaseRepository` (`_STAGE_DRAFTS = "pw_stage_drafts"`, `upsert(..., on_conflict="project_id,stage")`, `_dump` as the neighbours do)**

- [ ] **Step 4: Write the migration**

```sql
-- 0011_pw_stage_drafts — agent-written planning drafts and provenance
-- (design 2026-10-24-local-agent-brownfield-planning). Idempotent.
-- Service-only like pw_repo_analyses: every rule lives in app/api/stage_drafts.py.
-- DEPLOY ORDER: apply BEFORE deploying this code (the adapter inserts `source`).
alter table pw_repo_analyses add column if not exists source text not null default 'cloud';
alter table pw_repo_analyses add column if not exists model text;
alter table pw_stage_documents add column if not exists source text;

create table if not exists pw_stage_drafts (
    id uuid primary key,
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null,
    stage text not null check (stage in ('constitution','specify','plan','tasks')),
    markdown text not null,
    source text not null default 'agent',
    model text,
    status text not null default 'pending' check (status in ('pending','rejected')),
    rejection_note text,
    last_error text,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    unique (project_id, stage)
);
alter table pw_stage_drafts enable row level security;
revoke all on pw_stage_drafts from authenticated;
revoke all on pw_stage_drafts from anon;
grant select, insert, update, delete on pw_stage_drafts to service_role;
```

Add `"pw_stage_drafts"` to `_SERVICE_ONLY_TABLES` with a two-line comment in the file's style.

- [ ] **Step 5: Run tests and lint**

Run: `cd apps/cloud && pytest tests/test_stage_drafts_repo.py tests/test_repo_analysis_api.py -q && ruff check .`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/cloud/migrations/0011_pw_stage_drafts.sql apps/cloud/app/models/schemas.py apps/cloud/app/db/repository.py apps/cloud/app/db/supabase_repository.py apps/cloud/tests/test_stage_drafts_repo.py
git commit -m "feat(cloud): pw_stage_drafts table and provenance columns for agent planning"
```

---

### Task 2: Agent-written repo analysis route

**Files:**
- Modify: `apps/cloud/app/api/repo_analysis.py` (new route after the PATCH at line 368)
- Modify: `apps/cloud/app/models/schemas.py` (new input model near `RepoAnalysisBaselineUpdate`)
- Test: `apps/cloud/tests/test_repo_analysis_api.py` (append)

**Interfaces:**
- Consumes: `RepoAnalysis.source/model` (Task 1); `filter_paths`, `listed_paths`, `summarize_tree`, `detect_stack`, `MAX_PATHS` from `app/imports/snapshot.py`; `RepoStack`.
- Produces:
  ```python
  class AgentRepoAnalysisIn(BaseModel):
      default_branch: str = Field(min_length=1, max_length=200)
      commit_sha: str = Field(min_length=7, max_length=64)
      paths: list[str] = Field(default_factory=list, max_length=50_000)
      file_count: int = Field(ge=0)
      tree_truncated: bool = False
      stack: RepoStack = Field(default_factory=RepoStack)
      tree_summary: str = Field(default="", max_length=20_000)
      baseline: str = Field(min_length=1, max_length=100_000)
      model: str | None = Field(default=None, max_length=200)

  # POST /projects/{project_id}/repo-analysis/agent  -> RepoAnalysisOut, 200
  # 403 admin_required · 409 repo_not_imported · 409 repo_already_created · 413 when baseline > 100k (Pydantic 422 is acceptable only if the web/MCP map it; prefer an explicit 413 check before validation using a raw body length guard, see note)
  ```
  Note: FastAPI validates before the handler runs, so a too-long baseline is a 422. Keep 422 and map it in the MCP tool text; do not add a raw-body guard. Record this in the design's "Calls" list in Task 9.

- [ ] **Step 1: Write the failing tests**

```python
def _agent_analysis(client, pid, headers=ALICE, **over):
    body = {"default_branch": "main", "commit_sha": HEAD, "paths": ["README.md", "src/server.js"],
            "file_count": 2, "stack": {"runtime": "node", "manifests": ["package.json"], "languages": ["javascript"]},
            "tree_summary": "src/ 1", "baseline": "# Baseline\n\nExpress app.", "model": "claude-opus-5-5"}
    body.update(over)
    return client.post(f"/projects/{pid}/repo-analysis/agent", json=body, headers=headers)

def test_agent_analysis_opens_the_gate_and_records_provenance(client):
    _, pid = _imported_project(client)
    res = _agent_analysis(client, pid)
    assert res.status_code == 200 and res.json()["status"] == "baseline_ready"
    stored = client.app.state.repository.get_repo_analysis(pid)
    assert (stored.source, stored.model, stored.commit_sha) == ("agent", "claude-opus-5-5", HEAD)
    assert _generate(client, pid, "plan").status_code != 409 or _generate(client, pid, "plan").json()["detail"] != "repo_analysis_required"

def test_agent_analysis_filters_secret_shaped_paths_server_side(client):
    _, pid = _imported_project(client)
    _agent_analysis(client, pid, paths=["README.md", ".env", "keys/deploy.pem", "node_modules/x.js"], file_count=4)
    paths = client.app.state.repository.get_repo_analysis(pid).snapshot.paths
    assert paths == ["README.md"]

def test_agent_analysis_is_admin_only_and_refused_for_scratch_or_created(client):
    _, pid = _imported_project(client)
    assert _agent_analysis(client, pid, headers=BOB).status_code == 403
    _, scratch = _scratch_project(client)
    assert _agent_analysis(client, scratch).json()["detail"] == "repo_not_imported"

def test_agent_analysis_replaces_a_cloud_analysis_and_keeps_stale_working(client, monkeypatch):
    # cloud analysis first, agent second: source flips, GET still compares against branch head
```

- [ ] **Step 2: Run, expect 404 on the new route**

Run: `cd apps/cloud && pytest tests/test_repo_analysis_api.py -k agent_analysis -v`

- [ ] **Step 3: Implement `submit_agent_analysis(project_id, body: AgentRepoAnalysisIn, user, repo) -> RepoAnalysisOut`**

Let `kept = filter_paths(body.paths)`. Build `RepoSnapshot(commit_sha=body.commit_sha, default_branch=body.default_branch, file_count=body.file_count, tree_truncated=body.tree_truncated, tree_summary=body.tree_summary or summarize_tree(kept), stack=body.stack if body.stack.manifests or body.stack.runtime else detect_stack(kept), paths=listed_paths(kept)[:MAX_PATHS])`. Store `file_count` as given. Then `RepoAnalysis(project_id, workspace_id, commit_sha=body.commit_sha, snapshot, baseline=body.baseline.strip(), status="baseline_ready", source="agent", model=body.model, created_by=user.id)` through `repo.upsert_repo_analysis`. Drop `_stale_cache[project_id]`. Return `_out(project, stored)`.

- [ ] **Step 4: Run tests and lint, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): agent-written repo analysis opens the planning gate"
```

---

### Task 3: Planning brief route

**Files:**
- Create: `apps/cloud/app/api/stage_drafts.py` (router; brief route first, drafts routes in Task 4)
- Create: `apps/cloud/app/generation/templates/agent-planning-brief.md`
- Modify: `apps/cloud/app/generation/prompts.py` (export `stage_template(stage: StageKind, *, existing_repo: bool) -> str` and `agent_planning_instructions() -> str`)
- Modify: `apps/cloud/app/main.py` (`app.include_router(stage_drafts.router)` after `repo_analysis.router`)
- Test: `apps/cloud/tests/test_planning_brief.py`

**Interfaces:**
- Consumes: `render_policy_context(scope, max_chars=30_000)` from `app/policies/registry.py`; `repo.list_documents(project_id)` with `extracted_text`; `repo.get_repo_analysis`; `repo.list_stage_drafts` (Task 1); `require_stage_access`, `ADMIN_ONLY_STAGES`; `requires_repo_analysis` from `app/api/generation.py`.
- Produces:
  ```python
  class PlanningBriefDraft(BaseModel):
      stage: str; status: StageDraftStatus; stale: bool; rejection_note: str | None; last_error: str | None; created_at: datetime

  class PlanningBriefOut(BaseModel):
      project_id: str
      project_name: str
      project_description: str
      policy_context: str                      # render_policy_context(..., max_chars=30_000)
      templates: dict[str, str]                # keys constitution, specify, plan, tasks (tasks = tasks-template-existing.md)
      prd_texts: list[dict[str, str]]          # [{"title", "text"}], each text capped at 40_000 chars
      analysis_status: RepoAnalysisStatus
      baseline: str
      drafts: list[PlanningBriefDraft]
      submittable_stages: list[str]            # stages require_stage_access allows this caller
      instructions: str                        # agent-planning-brief.md rendered

  # GET /projects/{project_id}/planning-brief -> PlanningBriefOut
  # 409 repo_not_imported · 409 repo_already_created · 403 when not a member (require_project)

  def compute_stale(draft: StageDraft, repo: Repository) -> bool   # in stage_drafts.py; predecessor doc updated_at > draft.created_at
  PREDECESSOR = {"specify": "constitution", "plan": "specify", "tasks": "plan"}
  ```
  `stale` for `constitution` is always False.

- [ ] **Step 1: Write the failing tests**

```python
def test_brief_carries_templates_policy_prds_and_submittable_stages(client):
    # imported project, one PRD with extracted_text, admin caller
    res = client.get(f"/projects/{pid}/planning-brief", headers=ALICE)
    body = res.json()
    assert set(body["templates"]) == {"constitution", "specify", "plan", "tasks"}
    assert "existing" in body["templates"]["tasks"].lower() or body["templates"]["tasks"] != cloud_template("tasks-template.md")
    assert body["submittable_stages"] == ["constitution", "specify", "plan", "tasks"]
    assert body["analysis_status"] == "none"

def test_brief_lists_only_member_stages_for_a_member(client):
    assert client.get(..., headers=BOB).json()["submittable_stages"] == ["specify", "tasks"]

def test_brief_refuses_scratch_and_created_projects(client): ...

def test_brief_marks_a_draft_stale_when_its_predecessor_moved(client):
    # upsert plan draft at t0; PATCH specify stage document after; brief says stale True
```

- [ ] **Step 2: Run, expect 404**

- [ ] **Step 3: Write `agent-planning-brief.md`**

Exact copy, the Skill text. Must state in this order: fetch `origin/<default_branch>` and read the repository with your own tools before writing; write the baseline with sections purpose, stack, architecture and modules, conventions observed, test and CI setup, deployment signals, gaps and risks, then call `submit_repo_analysis`; then draft constitution, specify, plan, tasks from the templates in that order, reviewing each yourself before the next, and call `submit_stage_draft` for each stage listed in `submittable_stages`; fix every warning `submit_stage_draft` returns and resubmit; stop. State that drafts are pending until a human accepts them in PromptWorkspace, and that tasks must describe changes to the modules named in the baseline and never re-scaffold. Name the task line grammar `- [ ] T001 [P] title` with indented `AC:` bullets and the `## Phase N:` headings, and that a path not in the repository must be marked `(new)`.

- [ ] **Step 4: Implement `stage_template`, `agent_planning_instructions`, the router and `compute_stale`; register the router**

- [ ] **Step 5: Run tests and lint, expect PASS**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(cloud): planning brief for an imported project's local agent"
```

---

### Task 4: Stage draft routes: submit, list, accept, reject

**Files:**
- Modify: `apps/cloud/app/api/stage_drafts.py`
- Modify: `apps/cloud/app/models/schemas.py` (input/output models below)
- Modify: `apps/cloud/app/generation/stage_apply.py:153` (`source` type widens to `Literal["generated", "manual", "agent"]`; written to `StageDocument.source`)
- Test: `apps/cloud/tests/test_stage_drafts_api.py`

**Interfaces:**
- Consumes: `apply_stage_content`, `parse_stage_output`, `parse_task_lines`, `missing_task_refs`, `unknown_task_paths`, `latest_decision`, `require_stage_access`, `requires_repo_analysis`, `compute_stale` (Task 3).
- Produces:
  ```python
  class StageDraftIn(BaseModel):
      stage: Literal["constitution", "specify", "plan", "tasks"]
      markdown: str = Field(min_length=1, max_length=100_000)
      model: str | None = Field(default=None, max_length=200)

  class StageDraftWarning(BaseModel):
      code: Literal["missing_task_numbers", "unmarked_new_paths"]
      items: list[Any]

  class StageDraftOut(BaseModel):
      id: str; project_id: str; stage: str; markdown: str; source: str; model: str | None
      status: StageDraftStatus; stale: bool; rejection_note: str | None; last_error: str | None
      created_by: str; created_at: datetime
      warnings: list[StageDraftWarning] = []

  class StageDraftRejectIn(BaseModel):
      note: str = Field(default="", max_length=2_000)

  # POST /projects/{id}/stage-drafts            body StageDraftIn      -> StageDraftOut 201   (per-stage access; 409 repo_not_imported / repo_already_created)
  # GET  /projects/{id}/stage-drafts                                   -> list[StageDraftOut] (member; markdown included)
  # POST /projects/{id}/stage-drafts/{stage}/accept                    -> StageDocumentSaved  (per-stage access; 404 draft_not_found; 409 requirement_required / intent_not_approved / spec_document_required / repo_analysis_required)
  # POST /projects/{id}/stage-drafts/{stage}/reject  body StageDraftRejectIn -> StageDraftOut (per-stage access; 404 draft_not_found)
  ```
  Accept calls `apply_stage_content(repo, project, stage, draft.markdown, source="agent", actor_id=user.id, app=request.app)`. On `projection in ("current", "not_applicable")` delete the draft. On `"failed"` upsert the draft with `last_error=applied.error` and return the `StageDocumentSaved` as-is. The `repo_analysis_required` pre-check applies to `plan` and `tasks` exactly as in `generate()`.

- [ ] **Step 1: Write the failing tests**

```python
def test_submit_stores_a_pending_draft_and_returns_task_warnings(client):
    # imported project with agent analysis (Task 2 helper), tasks markdown with T001, T003 and a path not in snapshot.paths and not marked (new)
    assert {w["code"] for w in res.json()["warnings"]} == {"missing_task_numbers", "unmarked_new_paths"}
    assert client.app.state.repository.get_stage_document(pid, "tasks") is None

def test_submit_respects_per_stage_access(client):
    assert client.post(..., json={"stage": "constitution", "markdown": "# r"}, headers=BOB).status_code == 403
    assert client.post(..., json={"stage": "specify", "markdown": "# s"}, headers=BOB).status_code == 201

def test_resubmit_replaces_and_clears_rejection_and_error(client): ...

def test_submit_refused_for_scratch_and_created_projects(client): ...

def test_accept_plan_without_a_requirement_saves_nothing(client):
    res = client.post(f"/projects/{pid}/stage-drafts/plan/accept", headers=ALICE)
    assert res.status_code == 409 and res.json()["detail"] == "requirement_required"
    assert client.app.state.repository.get_stage_document(pid, "plan") is None
    assert client.app.state.repository.get_stage_draft(pid, "plan") is not None

def test_accept_applies_through_the_shared_path_and_records_source(client):
    # accept specify: Requirement exists afterwards, stage document source == "agent", draft gone

def test_accept_keeps_the_draft_when_projection_fails(client):
    # tasks markdown with no checklist lines: document saved, projection "failed", draft still pending, last_error set

def test_accept_honours_the_intent_gate(client): ...   # open intent_approval decision -> 409 intent_not_approved

def test_reject_keeps_the_note_for_the_brief(client):
    # reject with note; GET /stage-drafts shows status rejected; planning-brief lists it with the note

def test_list_is_member_readable_and_computes_stale(client): ...
```

- [ ] **Step 2: Run, expect 404/405**

- [ ] **Step 3: Implement the four routes and widen `apply_stage_content`'s `source`**

`StageDocument.source` is set from `source` inside `apply_stage_content` where the document is built.

- [ ] **Step 4: Run the whole cloud suite and lint**

Run: `cd apps/cloud && pytest -q && ruff check .`
Expected: PASS, including the unchanged `test_stage_documents*.py` and `test_generation.py`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(cloud): stage drafts submitted by an agent, accepted or rejected by a human"
```

---

### Task 5: RLS probe for the new table

**Files:**
- Modify: `apps/cloud/tests/rls/test_graph_table_grants.py` (after `test_member_cannot_write_a_repo_analysis_directly` at line 202)

- [ ] **Step 1: Add `test_member_cannot_touch_stage_drafts_directly`**

Same shape as the repo-analysis probe: a member's raw PostgREST INSERT, PATCH and DELETE on `pw_stage_drafts` each answer SQLSTATE `42501`; a SELECT returns no rows.

- [ ] **Step 2: Run against local Supabase if available, otherwise confirm it skips naming the variable**

Run: `cd apps/cloud && pytest -m rls tests/rls/test_graph_table_grants.py -k stage_drafts -v`
Expected: PASS with the stack up (`supabase start`, `scripts/migrate.py apply --var embed_dim=1024`), SKIP naming `PROMPTWORKSPACE_RLS_SUPABASE_URL` otherwise. State which happened in the task report.

- [ ] **Step 3: Commit**

```bash
git commit -am "test(cloud): rls probe for pw_stage_drafts"
```

---

### Task 6: MCP tools and cloud-client methods

**Files:**
- Modify: `packages/cloud-client/src/client.ts` (after `getStageDocument`, line ~434) and `packages/cloud-client/src/types.ts` (wire types)
- Modify: `apps/mcp/src/server.ts` (`TOOLS` array; `CallToolRequestSchema` switch at line ~484; header comment lines 9-19; `instructions` string)
- Create: `apps/mcp/src/planning.ts` (the three handlers)
- Test: `apps/mcp/test/tools.test.ts` (fake cloud routes at line ~184; the "exactly the four tools" test at line 288)
- Test: `packages/cloud-client/test/client.test.ts` (one test per new method hitting the fake server)

**Interfaces:**
- Consumes: cloud routes from Tasks 2 to 4; `resolveProject` pattern from `src/projectResolve.ts` (`workspace_root` default cwd, `project_id` override); `failure(text)` and `text(...)` helpers in `server.ts`.
- Produces:
  ```ts
  // cloud-client
  getPlanningBrief(projectId: string): Promise<PlanningBrief>
  postAgentRepoAnalysis(projectId: string, body: AgentRepoAnalysisIn): Promise<RepoAnalysisOut>
  postStageDraft(projectId: string, body: StageDraftIn): Promise<StageDraftOut>

  // MCP tools (inputSchema)
  start_planning        { workspace_root?: string; project_id?: string }
  submit_repo_analysis  { workspace_root?, project_id?, default_branch: string, commit_sha: string, paths: string[], file_count: number, tree_truncated?: boolean, stack?: {runtime?, manifests?, languages?}, tree_summary?: string, baseline: string, model?: string }
  submit_stage_draft    { workspace_root?, project_id?, stage: "constitution"|"specify"|"plan"|"tasks", markdown: string, model?: string }
  ```
  Tool text results: `start_planning` returns the brief as Markdown sections (instructions first, then templates, policy, PRDs, baseline, drafts, submittable stages). `submit_repo_analysis` returns one line confirming `baseline_ready` and the commit. `submit_stage_draft` returns the status and, when present, each warning as a bullet the agent can act on. A cloud 403 becomes a tool error `You may not author <stage> in this project; ask a workspace admin.` A 409 becomes a tool error carrying the detail code and one plain sentence. A 422 on length becomes `The <field> is longer than 100,000 characters; shorten it.`

- [ ] **Step 1: Update the tool-count test and add failing tool tests**

```ts
test("the server advertises the four plan 0025 tools and the three planning tools", ...)  // names asserted exactly
test("start_planning resolves the project from the clone and renders the brief", ...)
test("submit_repo_analysis posts the snapshot and reports the gate open", ...)
test("submit_stage_draft relays the cloud's warnings as bullets", ...)
test("submit_stage_draft on a stage the caller may not author is a tool error naming the stage", ...)  // fake cloud answers 403 {"detail":"admin_required"}
test("planning tools never enqueue: a 5xx is a tool error, not a queued write", ...)      // queue.json absent after a 503
```

Fake cloud routes to add: `GET /projects/proj-1/planning-brief`, `POST /projects/proj-1/repo-analysis/agent`, `POST /projects/proj-1/stage-drafts`.

- [ ] **Step 2: Run, expect failures on unknown tools**

Run: `pnpm --dir apps/mcp test`

- [ ] **Step 3: Implement cloud-client methods and types, `planning.ts`, register tools, rewrite the header comment and `instructions`**

Header: replace "Four tools, and the ceiling is deliberate" with a paragraph stating seven tools, that the three planning tools exist for an imported project before `repo_created` and write only pending drafts and the analysis row, and that the `PUT /sync/.../graph` and claim-tool prohibitions stand.

- [ ] **Step 4: Typecheck and test both packages**

Run: `pnpm --dir packages/cloud-client test && pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloud-client apps/mcp
git commit -m "feat(mcp): start_planning, submit_repo_analysis and submit_stage_draft"
```

---

### Task 7: Web: types, API client, checklist panel

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`RepoAnalysisOut` gains `source: "cloud" | "agent"; model: string | null`; add `StageDraftOut`, `StageDraftWarning`)
- Modify: `apps/web/src/lib/api.ts` (add `listStageDrafts`, `acceptStageDraft`, `rejectStageDraft`)
- Modify: `apps/web/src/components/project/CodebaseAnalysisPanel.tsx`
- Create: `apps/web/src/components/project/AgentPlanningChecklist.tsx`
- Test: `apps/web/src/components/project/CodebaseAnalysisPanel.test.tsx`, `apps/web/src/components/project/AgentPlanningChecklist.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function listStageDrafts(projectId: string, authHeaders): Promise<StageDraftOut[]>
  export function acceptStageDraft(projectId: string, stage: StageKind, authHeaders): Promise<StageDocumentSaved>
  export function rejectStageDraft(projectId: string, stage: StageKind, note: string, authHeaders): Promise<StageDraftOut>

  export function AgentPlanningChecklist(props: { projectId: string; analysis: RepoAnalysisOut; drafts: StageDraftOut[] }): JSX.Element
  // CodebaseAnalysisPanel gains prop `drafts: StageDraftOut[]` and renders AgentPlanningChecklist in place of the Analyze/Re-analyze button whenever analysis.required is true.
  ```
  Checklist copy (exact): step 1 "Install the PromptWorkspace MCP server and sign in" with code `promptworkspace-mcp login`; step 2 "Open this repository in your coding agent and paste:" with code `Call the PromptWorkspace start_planning tool for this repository and follow its instructions.`; step 3 "Wait for drafts" with five rows labelled Baseline, Rules, Specification, Plan, Tasks, each showing `Waiting`, `Pending review`, `Rejected` or `Accepted` (Accepted when the stage document exists and no draft is pending; Baseline shows Accepted when `analysis.status === "baseline_ready"`).

- [ ] **Step 1: Write failing tests**

```ts
it("shows the checklist instead of the Analyze button for a required analysis", ...)
it("marks the baseline row accepted for a pre-existing cloud baseline and keeps stage rows waiting", ...)
it("marks a stage row pending review when a draft exists", ...)
it("still lets an admin edit and save the baseline", ...)   // existing save test, kept green
```

- [ ] **Step 2: Run, expect failures**

Run: `pnpm --dir apps/web test -- CodebaseAnalysisPanel AgentPlanningChecklist`

- [ ] **Step 3: Implement types, API functions, checklist component, and the panel change**

`useRepoAnalysis` and `analyze` are no longer called from the panel; remove the import, keep the hook file (the Planner test suite still references the SSE path for the error mapping test at line 1286, which stays valid against the cloud route).

- [ ] **Step 4: Typecheck and test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): agent planning checklist replaces Analyze for imported projects"
```

---

### Task 8: Web: draft banner and hidden Generate/Prefill on imported projects

**Files:**
- Create: `apps/web/src/components/project/StageDraftBanner.tsx`
- Modify: `apps/web/src/components/project/Planner.tsx` (`StageSection` props at line ~205; the Generate/Prefill render at lines ~425-445; analysis state at line ~855; `blockedBy` at line ~908)
- Test: `apps/web/src/components/project/StageDraftBanner.test.tsx`, `apps/web/src/components/project/Planner.test.tsx`

**Interfaces:**
- Consumes: `listStageDrafts`, `acceptStageDraft`, `rejectStageDraft` (Task 7); `blockedBy(meta)`; `isTechLead`; `ADMIN_ONLY_STAGES` in Planner.
- Produces:
  ```ts
  export function StageDraftBanner(props: {
    draft: StageDraftOut;
    canAct: boolean;            // require_stage_access mirrored: isTechLead || !ADMIN_ONLY_STAGES.includes(stage)
    blockedBy?: string;         // predecessor not accepted; disables Accept and shows the text
    onAccept: () => Promise<void>;
    onReject: (note: string) => Promise<void>;
  }): JSX.Element
  // Planner: new state `drafts: StageDraftOut[]` loaded with the analysis when analysisRequired; refetched after accept/reject; StageSection gets `draft?: StageDraftOut` and `agentPlanned: boolean`. When agentPlanned, the Generate button and prefill control are not rendered; the editor and Save stay.
  ```
  Banner copy: heading `Draft from your coding agent` with source and model chip; `Stale: written before the previous step changed` badge when `draft.stale`; `Rejected: <note>` line when status is rejected; `Could not apply: <last_error>` line when set; buttons `Accept` and `Reject`; Reject opens a one-line note input and a `Confirm` button. Members on an admin-only stage see the banner without buttons and the line `Your Tech Lead reviews this draft.`

- [ ] **Step 1: Write failing tests**

```ts
// StageDraftBanner.test.tsx
it("loads the draft into view with source, model and a stale badge", ...)
it("accepts, and disables Accept when blockedBy is set", ...)
it("asks for a note before rejecting", ...)
it("shows a member no buttons on an admin-only stage", ...)
// Planner.test.tsx
it("hides Generate and the draft button on an imported project and shows the draft banner", ...)
it("refetches drafts and the document after a draft is accepted", ...)
it("keeps Generate for a project started from scratch", ...)
```

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement banner and Planner wiring**

On accept: call `acceptStageDraft`, then the same `onDocStamp`/`onGraphChange`/document reload the Save path runs; if the response's `projection === "failed"`, keep the banner and show `error` through the existing `PROJECTION_ERROR_TEXT` map if one exists, else the raw code.

- [ ] **Step 4: Typecheck and run the web suite, expect PASS**

Run: `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(web): review and accept agent drafts in the Planner; no Typhoon buttons on imported projects"
```

---

### Task 9: Documentation amendments

**Files:**
- Modify: `docs/plans/0025-mcp-server.md` (dated amendment section at the end; status line gains "amended 2026-10-24: three planning tools")
- Modify: `CLAUDE.md` lines 27 and 86 (tool list and the "no new tools" phrasing; keep the graph-write and claim-tool prohibitions verbatim)
- Modify: `apps/mcp/README.md` §"What it is, and what it is not" (add the three tools and when they apply)
- Modify: `docs/plans/0027-brownfield-repo-import.md` status line (pointer: planning for imported projects moved to the local agent, see the design)
- Modify: `docs/superpowers/specs/2026-10-24-local-agent-brownfield-planning-design.md` "Calls made by the author" (add: a too-long body is Pydantic's 422, mapped to words in the MCP tool, not a 413)
- Modify: `docs/DEPLOYMENT.md` §2.2 migration order list (0011 applies before the code deploy)

- [ ] **Step 1: Write the amendments in the surrounding prose style**

- [ ] **Step 2: Grep for stale claims**

Run: `grep -rn "Four tools\|four tools\|exactly the four" apps/mcp CLAUDE.md docs/plans/0025-mcp-server.md`
Expected: no hits outside the amendment's own historical sentence.

- [ ] **Step 3: Commit**

```bash
git commit -am "docs: plan 0025 amendment, CLAUDE.md and README for the planning MCP tools; migration 0011 deploy order"
```

---

### Task 10: Whole-branch verification

- [ ] **Step 1: Run every suite**

```bash
cd apps/cloud && pytest -q && ruff check . && cd ../..
pnpm --dir packages/cloud-client test
pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp build && pnpm --dir apps/mcp test
pnpm --dir apps/web typecheck && pnpm --dir apps/web test
```
Expected: all PASS. Paste the final summary lines in the report.

- [ ] **Step 2: Manual round trip against the in-memory cloud**

Start `uvicorn app.main:app --port 8080` with `DATA_BACKEND=memory`; point `apps/mcp` at it (`PROMPTWORKSPACE_CLOUD_API_URL=http://localhost:8080`, stub auth header path per README); from a clone, call `start_planning`, `submit_repo_analysis`, `submit_stage_draft` for `specify`; confirm `GET /projects/{id}/stage-drafts` lists it and the web banner renders it. Record what was observed.

- [ ] **Step 3: Confirm no placeholders**

Run: `git diff origin/feature/trust-outcome...HEAD | grep -nE "TODO|FIXME|test\.skip|\.only\(|NotImplementedError"`
Expected: no hits.
