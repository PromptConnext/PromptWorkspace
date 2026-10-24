# 0033: Workspace overview and AI governance, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented 2026-10-24 on `feature/workspace-overview` (M1 to M4, Tasks 1 to 21). Closing checklist pending the trust walkthrough.

**Goal:** A Tech Lead opens the workspace and sees, in one screen, who works on which project with what stack, which projects break the workspace's rules, how AI is being used, and can ask the workspace a question in plain words.

**Architecture:** Cloud gains one aggregate read (`GET /workspaces/{id}/overview`) built by a pure module (`app/overview/`) over existing tables plus three new repository reads; a workspace governance row that projects inherit their policy scope from; an `agent` field on task-closing artifacts; and a facts-first SSE "ask" endpoint. Web replaces the project list with cards, adds a people map (`d3-force`), a governance section in workspace settings, and an ask box. One migration, `0011`.

**Tech Stack:** FastAPI + pytest (`apps/cloud`), Postgres migration via `scripts/migrate.py`, Next.js 16 + React 19 + vitest (`apps/web`), `@modelcontextprotocol/sdk` (`apps/mcp`), VS Code extension (`apps/vscode`), `d3-force` (ISC).

**Spec:** `docs/superpowers/specs/2026-10-24-workspace-overview-and-governance-design.md` (approved 2026-10-24).

## Global Constraints

- Every change lands with a test that fails first. Cloud tests hermetic (`DATA_BACKEND=memory`, `tests/conftest.py`). Any new `Repository` method is implemented on `InMemoryRepository` (`app/db/repository.py`) and `SupabaseRepository` (`app/db/supabase_repository.py`), and pinned in `tests/contract/`.
- Cloud: `ruff check .` clean, line length 100. Web: `tsc --noEmit` and `vitest run` green. MCP and VS Code: `typecheck` and `test` green.
- Migration `0011_pw_workspace_governance.sql`: idempotent, header in the style of `0010`, `pw_workspace_governance` service-only (RLS enabled, no policy, `authenticated`/`anon` revoked). Apply before deploying.
- `GET /workspaces/{id}/overview` never calls GitHub; at most one query per table family against Supabase; serves up to 200 projects, then `truncated: true`.
- `pw_tasks.assigned_user_id` and `pw_project_roles.user_id` are `text`; `pw_workspace_members.user_id` is `uuid`. Compare as strings in Python; cast in SQL.
- Only new runtime dependency in `apps/web`: `d3-force`.
- The ask endpoint sends only the `WorkspaceFacts` structure to the model, never document text, discussion bodies or decision snapshots.
- No `BackgroundTasks` on a request path.
- Copy: sentence case, no exclamation marks. Governance sentences are exactly those in spec §4.3.
- Names: `display_name` preferred, email fallback, never a raw user id (spec §7).

## Review Focus

1. A workspace with 0 projects, and a project with no roles, no tasks, no analysis, no decisions: the overview returns a card with nulls and zeros, never 500. Task 5 pins it (`overview_empty_project_has_nulls_and_zero_counts`).
2. A member who left the workspace still appears as `assigned_user_id` on tasks: contributors keep the id, the card renders "Unknown member", nothing crashes. Task 6 pins it (`unknown contributor renders Unknown member`).
3. A workspace scope change must not touch a frozen (`repo_created`) project or a project with its own scope, and must write one receipt per rewritten project only. Task 9 pins it (`put_governance_rewrites_only_inheriting_unfrozen_projects`).
4. The push webhook creates the artifact before the editor's PATCH: `agent` must be merged in, and a second PATCH with a different client must not overwrite it. Task 16 pins it (`upsert_artifact_merges_agent_once`).
5. Ask with no model connection and no managed key still answers from facts, and the stream ends cleanly. Task 20 pins it (`ask_without_model_streams_facts_only`).

---

## M1: Cards

### Task 1: Migration 0011

**Files:**
- Create: `apps/cloud/migrations/0011_pw_workspace_governance.sql`

**Interfaces:**
- Produces: tables and columns every later task reads: `pw_workspace_governance`, `pw_projects.policy_scope_source`, `pw_artifacts.agent`, `pw_workspace_members.display_name`, `pw_generation_runs.project_id` nullable, `pw_receipts.subject_type` check widened.

- [x] **Step 1: Write the migration**

Header in the style of `0010` (THE PROBLEM / SHAPE / GRANTS / DEPLOY ORDER). Body, every statement idempotent:

```sql
create table if not exists pw_workspace_governance (
    workspace_id uuid primary key references pw_workspaces (id) on delete cascade,
    policy_scope jsonb not null default '{"selected": [], "custom_text": ""}'::jsonb,
    required_hats text[] not null default '{business_owner,tech_steward}',
    require_seeded_rules boolean not null default true,
    updated_by uuid,
    updated_at timestamptz not null default now()
);
alter table pw_workspace_governance enable row level security;
revoke all on pw_workspace_governance from authenticated;
revoke all on pw_workspace_governance from anon;
grant select, insert, update, delete on pw_workspace_governance to service_role;

alter table pw_projects add column if not exists policy_scope_source text not null default 'project';
alter table pw_projects drop constraint if exists pw_projects_policy_scope_source_check;
alter table pw_projects add constraint pw_projects_policy_scope_source_check
    check (policy_scope_source in ('workspace', 'project'));

alter table pw_artifacts add column if not exists agent jsonb;
alter table pw_workspace_members add column if not exists display_name text;
alter table pw_generation_runs alter column project_id drop not null;

alter table pw_receipts drop constraint if exists pw_receipts_subject_type_check;
alter table pw_receipts add constraint pw_receipts_subject_type_check
    check (subject_type in ('decision', 'project_role', 'project_policy'));
```

Check the actual constraint name of the `subject_type` check in `0007_pw_receipts.sql` before writing the drop; use that name.

- [x] **Step 2: Verify the file parses and is idempotent**

Run: `cd apps/cloud && python scripts/migrate.py --help` to confirm the tool; if a local Supabase is running, `python scripts/migrate.py --db-url "$POOLER_URL" apply --dry-run --var embed_dim=1024` twice. Otherwise rely on the CI baseline gate (`.github/workflows`, "additive migrations").
Expected: no error; second dry-run reports nothing new.

- [x] **Step 3: Commit**

```bash
git add apps/cloud/migrations/0011_pw_workspace_governance.sql
git commit -m "feat(cloud): migration 0011 workspace governance, display names, artifact agent"
```

### Task 2: People have names

**Files:**
- Modify: `apps/cloud/app/models/schemas.py:321` (`WorkspaceMember`), `app/db/repository.py` (abstract + memory), `app/db/supabase_repository.py`, `app/api/workspaces.py`
- Modify: `apps/web/src/lib/types.ts:23`, `apps/web/src/lib/identity.ts`, `apps/web/src/components/project/MemberChip.tsx:14`, `apps/web/src/app/w/[workspaceId]/members/page.tsx`, `apps/web/src/lib/api.ts`
- Test: `apps/cloud/tests/test_members_display_name.py`, `apps/web/src/lib/identity.test.ts`, `apps/web/src/app/w/[workspaceId]/members/DisplayNameField.test.tsx`

**Interfaces:**
- Produces: `WorkspaceMember.display_name: str | None`; `Repository.set_member_display_name(workspace_id: str, user_id: str, display_name: str | None) -> WorkspaceMember`; `PATCH /workspaces/{id}/members/{user_id}` body `{"display_name": str | null}`; web `displayName(identity)` prefers `display_name`; `updateMemberDisplayName(workspaceId, userId, displayName, authHeaders)` in `api.ts`.

- [x] **Step 1: Write the failing cloud tests**

```python
def test_member_sets_own_display_name(client, workspace):
    r = client.patch(f"/workspaces/{workspace}/members/bob", json={"display_name": "Somchai"}, headers=BOB)
    assert r.status_code == 200 and r.json()["display_name"] == "Somchai"
    assert [m["display_name"] for m in client.get(f"/workspaces/{workspace}/members", headers=BOB).json() if m["user_id"] == "bob"] == ["Somchai"]

def test_member_cannot_rename_other(client, workspace):
    assert client.patch(f"/workspaces/{workspace}/members/alice", json={"display_name": "X"}, headers=BOB).status_code == 403

def test_admin_renames_anyone_and_clears(client, workspace):
    assert client.patch(f"/workspaces/{workspace}/members/bob", json={"display_name": "B"}, headers=ALICE).status_code == 200
    assert client.patch(f"/workspaces/{workspace}/members/bob", json={"display_name": None}, headers=ALICE).json()["display_name"] is None

def test_display_name_length_capped(client, workspace):
    assert client.patch(f"/workspaces/{workspace}/members/bob", json={"display_name": "x" * 81}, headers=BOB).status_code == 422
```

Fixture `workspace` as in `tests/test_delivery_api.py` (alice creates, bob accepts an invitation).

- [x] **Step 2: Run, expect 404/405**

Run: `cd apps/cloud && pytest tests/test_members_display_name.py -v`

- [x] **Step 3: Implement**

`WorkspaceMember.display_name: str | None = None` (cap 80 characters, stripped; empty string becomes `None`). `MemberDisplayNameUpdate(BaseModel)` with `display_name: str | None`. Repository method on both adapters (Supabase: update `pw_workspace_members` where `workspace_id` and `user_id`). Route in `workspaces.py`: `require_workspace`; allow when `user.id == user_id` or caller is admin, else 403 `display_name_forbidden`; 404 `member_not_found`.

- [x] **Step 4: Run cloud tests, expect PASS; `ruff check .`**

- [x] **Step 5: Write the failing web tests**

`identity.test.ts`: `displayName({display_name: "Somchai", email: "s@x.com", user_id: "u"})` is `"Somchai"`; with `display_name: null` it is the email; `initial` uses the first character of the same source. `DisplayNameField.test.tsx`: renders an input prefilled with the current member's `display_name`, submit calls `updateMemberDisplayName` once with the trimmed value, shows "Saved".

- [x] **Step 6: Implement web**

Add `display_name: string | null` to `WorkspaceMember`; `identity.ts` functions take `{display_name?: string | null; email: string | null; user_id: string}`; `memberFullName` in `MemberChip.tsx` delegates to `displayName`. `DisplayNameField` component (`apps/web/src/components/DisplayNameField.tsx`) rendered on the members page above the list for the signed-in member, labelled "Your name". Admin: a pencil next to each row opening the same field for that member.

- [x] **Step 7: Run `pnpm --dir apps/web vitest run` and `tsc --noEmit`, expect PASS. Commit**

```bash
git commit -am "feat: members can set a display name"
```

### Task 3: Three repository reads

**Files:**
- Modify: `apps/cloud/app/models/schemas.py`, `app/db/repository.py`, `app/db/supabase_repository.py`
- Test: `apps/cloud/tests/contract/test_overview_reads.py`

**Interfaces:**
- Produces:
  - `class ArtifactAgent(BaseModel): client: str; model: str | None = None` and `Artifact.agent: ArtifactAgent | None = None` (schema only; the write path is Task 16)
  - `class TaskSummary(BaseModel): task_id: str; project_id: str; status: TaskStatus; assigned_user_id: str | None; agent_closed: bool; updated_at: datetime`
  - `Repository.list_tasks_summary(project_ids: list[str]) -> list[TaskSummary]` (non-tombstoned tasks; `agent_closed` is true when any artifact of the task has non-null `agent`)
  - `Repository.latest_receipt_at(project_ids: list[str]) -> dict[str, datetime]` (projects with no receipts absent)
  - `Repository.list_generation_runs(workspace_id: str, since: datetime) -> list[GenerationRun]` (created_at ≥ since, newest first)

- [x] **Step 1: Write the failing contract tests** (parametrised `repo` fixture from `tests/contract/conftest.py`)

```python
def test_list_tasks_summary_counts_and_agent_flag(repo): ...   # two projects, three tasks, one artifact with agent → agent_closed True on exactly that task
def test_list_tasks_summary_skips_tombstoned(repo): ...
def test_latest_receipt_at_only_for_projects_with_receipts(repo): ...
def test_list_generation_runs_since_newest_first(repo): ...
```

- [x] **Step 2: Run, expect `AttributeError`**

Run: `pytest tests/contract/test_overview_reads.py -v`

- [x] **Step 3: Implement on both adapters**

Supabase: `pw_tasks` select `id, project_id, status, assigned_user_id, updated_at` with `in_("project_id", ids)` and `deleted_at is null`; `pw_artifacts` select `task_id` where `agent is not null` for those tasks; `pw_receipts` select `project_id, created_at` ordered desc, first per project; `pw_generation_runs` filtered by `workspace_id` and `created_at >= since`. The test seeds the artifact's `agent` through `upsert_graph`, which already accepts whole `Artifact` rows.

- [x] **Step 4: Run, expect PASS (memory; Supabase parameter skips without env). `ruff check .`. Commit**

```bash
git commit -am "feat(cloud): repository reads for the workspace overview"
```

### Task 4: Pure card builder and checks

**Files:**
- Create: `apps/cloud/app/overview/__init__.py`, `app/overview/cards.py`, `app/overview/checks.py`
- Modify: `app/models/schemas.py` (output models)
- Test: `apps/cloud/tests/test_overview_cards.py`

**Interfaces:**
- Produces (schemas):
  - `ProjectCheckOut(id: str, ok: bool, text: str)`
  - `ProjectCardOut(id, name, lifecycle_status, live_url: str | None, updated_at, hats: dict[str, str | None], contributors: list[str], task_counts: dict[str, int], decisions: dict[str, int], stack: dict | None, policy: dict, checks: list[ProjectCheckOut], agent_closed_30d: int, last_activity_at: datetime)`
  - `WorkspaceGovernance(workspace_id, policy_scope: PolicyScope, required_hats: list[str], require_seeded_rules: bool, updated_by: str | None, updated_at)` with `WorkspaceGovernance.default(workspace_id)`
- Produces (functions):
  - `checks.run_checks(project: Project, roles: list[ProjectRole], decisions: list[Decision], governance: WorkspaceGovernance, now: datetime) -> list[ProjectCheckOut]` in spec §4.3 order, excluding `rules_in_repo`
  - `cards.build_card(project, roles, tasks: list[TaskSummary], decisions, analysis: RepoAnalysis | None, governance, latest_receipt_at: datetime | None, now) -> ProjectCardOut`

- [x] **Step 1: Write the failing tests**

```python
def test_card_counts_tasks_by_status(): ...
def test_contributors_distinct_most_tasks_first(): ...
def test_stack_from_analysis_runtime_and_three_languages(): ...
def test_stack_none_without_analysis(): ...
def test_decisions_open_overdue_expired_30d(): ...        # open past expiry → overdue 1; expired 10 days ago → expired_30d 1; expired 40 days ago → 0
def test_last_activity_is_max_of_project_tasks_receipt(): ...
def test_checks_order_and_sentences(): ...               # no steward + scope differs → first failing is hat_tech_steward with "No tech steward assigned"
def test_policy_check_skipped_when_workspace_scope_empty(): ...
def test_policy_empty_when_both_empty(): ...
def test_required_hats_respected(): ...                  # governance.required_hats = ["tech_steward"] → no business_owner check
```

Sentences exactly: "No business owner assigned", "No tech steward assigned", "Policy scope differs from the workspace", "No policy scope set", "N decisions past their due date" (singular "1 decision past its due date").

- [x] **Step 2: Run, expect ImportError. Step 3: Implement. Step 4: Run, PASS. `ruff check .`. Commit**

```bash
git commit -am "feat(cloud): overview card builder and governance checks"
```

### Task 5: `GET /workspaces/{id}/overview`

**Files:**
- Create: `apps/cloud/app/api/overview.py`
- Modify: `app/main.py` (include router), `app/db/repository.py` + `supabase_repository.py` (`get_workspace_governance(workspace_id) -> WorkspaceGovernance | None`)
- Test: `apps/cloud/tests/test_overview_api.py`

**Interfaces:**
- Produces: `WorkspaceOverviewOut(workspace_id, generated_at, members: list[WorkspaceMember], projects: list[ProjectCardOut], people: list[PersonLinkOut], truncated: bool)`; `PersonLinkOut(kind: Literal["hat","work","approval"], from_user_id: str, to_user_id: str | None, project_id: str | None, hat: str | None, weight: int)` (filled in Task 13; empty list here).
- Consumes: Task 3 reads, Task 4 builder, `require_workspace`.

- [x] **Step 1: Write the failing tests**

```python
def test_overview_requires_membership(client, workspace): ...                     # MALLORY → 403
def test_overview_empty_project_has_nulls_and_zero_counts(client, workspace): ... # stack None, hats both None, counts all 0, checks include hat_* failing
def test_overview_card_reflects_roles_tasks_decisions(client, workspace): ...
def test_overview_truncates_after_200(client, workspace): ...                     # 201 projects → 200 returned, truncated True, ordered by updated_at desc
def test_overview_uses_default_governance_without_row(client, workspace): ...
```

- [x] **Step 2: Run, expect 404. Step 3: Implement**

Route calls `list_projects_by_workspace`, sorts by `updated_at` desc, slices 200, then `list_tasks_summary`, `latest_receipt_at`, and per project `list_project_roles`, `list_decisions`, `get_repo_analysis`. Governance from `get_workspace_governance` or `WorkspaceGovernance.default`.

- [x] **Step 4: Run, PASS. `ruff check .`. Commit**

```bash
git commit -am "feat(cloud): GET /workspaces/{id}/overview"
```

### Task 6: Project cards on the workspace home

**Files:**
- Create: `apps/web/src/components/workspace/ProjectCard.tsx`, `ProjectCard.test.tsx`, `apps/web/src/components/workspace/useOverview.ts`
- Modify: `apps/web/src/lib/types.ts` (`WorkspaceOverview`, `ProjectCard`, `ProjectCheck`, `PersonLink`), `apps/web/src/app/w/[workspaceId]/page.tsx:83,117-180`

**Interfaces:**
- Produces: `<ProjectCard card={ProjectCard} members={WorkspaceMember[]} workspaceId={string} isAdmin={boolean} />`; `useOverview(workspaceId)` wrapping `useCloudGet<WorkspaceOverview>(`/workspaces/${id}/overview`)`.

- [x] **Step 1: Write the failing tests** (mock `@/lib/hooks` as in `DecisionsPanel.test.tsx`)

```ts
it("leads with people: hat holders then contributors", ...)      // Somchai (Tech steward), "+2" after five avatars
it("hat with no holder reads No tech steward and links to settings for admins", ...)
it("unknown contributor renders Unknown member", ...)
it("stack line shows runtime and up to three languages, or Not analysed yet", ...)
it("state line: 3 in progress · 12 done · 2 decisions waiting", ...)
it("overdue decision turns amber: 1 decision overdue", ...)
it("governance line: Follows workspace rules when all checks pass, else first failing sentence", ...)
it("Live pill links to live_url", ...)
```

- [x] **Step 2: Run `vitest run ProjectCard`, expect fail. Step 3: Implement**

Card layout per spec §1. Use `MemberChip`, `Avatar`, existing slate/emerald/amber classes. Home page: `max-w-6xl`, grid `sm:grid-cols-2 xl:grid-cols-3`, data from `useOverview`; keep header, empty state and `NewProjectDialog`; drop the `/projects` and `/members` fetches (overview carries members).

- [x] **Step 4: `vitest run`, `tsc --noEmit`, PASS. Commit**

```bash
git commit -am "feat(web): workspace home shows project cards"
```

### Task 7: Lazy repository drift on the card

**Files:**
- Modify: `apps/web/src/components/workspace/ProjectCard.tsx`, `ProjectCard.test.tsx`

- [x] **Step 1: Write the failing tests**

```ts
it("repo_created project fetches docs-status and shows Rules in the repository differ from the plan when any file is not in_sync", ...)
it("planning project does not fetch docs-status", ...)
it("drift check is skipped when governance.require_seeded_rules is false", ...)   // card.policy carries require_seeded_rules from the overview
```

- [x] **Step 2: Fail. Step 3: Implement**

`useCloudGet<RepositoryDocsStatus>(`/projects/${id}/repository/docs-status`, card.lifecycle_status === "repo_created" && requireSeededRules)`. Add `require_seeded_rules: boolean` to `ProjectCardOut.policy` (cloud, one line in Task 4's builder plus its test). The drift sentence ranks after the server checks.

- [x] **Step 4: PASS both suites. Commit**

```bash
git commit -am "feat(web): project card shows repository rules drift"
```

---

## M3: Governance

### Task 8: Governance row, read and write

**Files:**
- Modify: `apps/cloud/app/db/repository.py`, `supabase_repository.py` (`put_workspace_governance(g: WorkspaceGovernance) -> WorkspaceGovernance`), `app/api/overview.py` (governance routes), `app/models/schemas.py` (`WorkspaceGovernanceUpdate`)
- Test: `apps/cloud/tests/test_governance_api.py`

**Interfaces:**
- Produces: `GET /workspaces/{id}/governance` (member; default when no row, never writes); `PUT /workspaces/{id}/governance` (admin) body `{policy_scope: {selected, custom_text}, required_hats: [...], require_seeded_rules: bool}` → `WorkspaceGovernance`.

- [x] **Step 1: Failing tests**

```python
def test_get_governance_default_without_row(client, workspace): ...        # selected [], required_hats both, require_seeded_rules True; repo has no row afterwards
def test_put_governance_admin_only(client, workspace): ...                 # BOB → 403
def test_put_governance_validates_template_ids_and_text_cap(client, workspace): ...  # 422 unknown_policy_template / custom_text_too_long
def test_put_governance_round_trips(client, workspace): ...
```

- [x] **Step 2: Fail. Step 3: Implement** (reuse `get_template` and `_MAX_CUSTOM_TEXT_CHARS` from `app/api/policies.py`; move the validation into a shared `validate_scope(body) -> PolicyScope` in `app/policies/scope.py` and call it from both routes). **Step 4: PASS, ruff. Commit**

```bash
git commit -am "feat(cloud): workspace governance row and routes"
```

### Task 9: Projects inherit the workspace scope

**Files:**
- Modify: `app/models/schemas.py` (`Project.policy_scope_source: Literal["workspace","project"] = "project"`, `ReceiptDraft.subject_type` adds `"project_policy"`, `ReceiptEvent` adds `"policy_scope.updated"`), `app/api/sync.py:151` (create), `app/api/policies.py:51` (PATCH sets source), `app/api/overview.py` (PUT governance fan-out + new route), `app/db/repository.py` + Supabase (`update_project_policy_scope` gains `source: str` keyword)
- Test: `apps/cloud/tests/test_policy_scope_inheritance.py`

**Interfaces:**
- Produces: `POST /projects/{id}/policy-scope/use-workspace` (member; 409 `project_frozen` when `repo_created`) → `Project`.

- [x] **Step 1: Failing tests**

```python
def test_new_project_copies_workspace_scope_with_source_workspace(client, workspace): ...
def test_project_patch_sets_source_project(client, workspace): ...
def test_put_governance_rewrites_only_inheriting_unfrozen_projects(client, workspace): ...
    # three projects: inheriting+planning (rewritten, one receipt policy_scope.updated with body {source:"workspace", before, after}), own scope (untouched, no receipt), inheriting+repo_created (untouched, no receipt)
def test_use_workspace_copies_and_sets_source(client, workspace): ...
def test_use_workspace_refused_when_frozen(client, workspace): ...
def test_receipt_chain_still_verifies_after_policy_receipt(client, workspace): ...   # GET /projects/{id}/receipts then verify_chain ok
```

Receipt body holds template ids joined by `,` as strings (`before`, `after`), never custom text.

- [x] **Step 2: Fail. Step 3: Implement.** Fan-out writes receipts through the same seal path `delivery.py` uses for decisions. **Step 4: PASS, ruff. Commit**

```bash
git commit -am "feat(cloud): projects inherit the workspace policy scope"
```

### Task 10: Governance report (usage and discipline)

**Files:**
- Create: `app/overview/report.py`
- Modify: `app/api/overview.py`, `app/models/schemas.py`
- Test: `apps/cloud/tests/test_governance_report.py`

**Interfaces:**
- Produces: `GET /workspaces/{id}/governance/report` (admin) → `GovernanceReportOut(usage: list[UsageSourceOut], discipline: DisciplineOut, projects: list[{project_id, name, checks}])`.
  - `UsageSourceOut(source: Literal["managed","byo"], provider: str | None, runs: int, tokens: int, today_tokens: int, daily_budget: int | None, by_stage: list[{stage, runs, model, tokens}])`
  - `DisciplineOut(resolved: int, open: int, expired_30d: int, median_hours_to_decide: float | None, chains_verified: int, chains_total: int)`
- Consumes: `list_generation_runs(workspace_id, now - 30 days)`, `settings.managed_daily_token_budget`, workspace model connection `daily_token_budget`, `list_receipts` + `verify_chain`.

- [x] **Step 1: Failing tests**

```python
def test_report_admin_only(client, workspace): ...
def test_usage_split_by_source_with_own_budget(client, workspace): ...   # managed budget from settings, byo from connection; a source with no runs absent
def test_discipline_counts_and_median(client, workspace): ...
def test_chains_verified_per_project(client, workspace): ...
```

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS, ruff. Commit**

```bash
git commit -am "feat(cloud): governance report"
```

### Task 11: Shared policy scope editor and the governance page

**Files:**
- Create: `apps/web/src/components/policy/PolicyScopeEditor.tsx` (lifted from `PolicyScopePanel.tsx:41-223`: templates list, checkboxes, textarea; props `scope`, `templates`, `readOnly`, `onSave(scope)`), `apps/web/src/components/workspace/GovernancePanel.tsx`, `GovernancePanel.test.tsx`
- Modify: `apps/web/src/components/project/PolicyScopePanel.tsx` (uses the editor; adds "Inherited from the workspace" / "This project uses its own scope" line and a **Use workspace scope** button), `PolicyScopePanel.test.tsx`, `apps/web/src/lib/api.ts` (`getGovernance`, `putGovernance`, `useWorkspaceScope(projectId)`), `apps/web/src/lib/types.ts`, `apps/web/src/app/w/[workspaceId]/settings/page.tsx:40-50`

- [x] **Step 1: Failing tests**

```ts
// GovernancePanel
it("renders the scope editor, two switches on by default, and a project row per project with its check sentences", ...)
it("Applies to N projects. M projects use their own scope. names the deviating projects", ...)
it("saving calls putGovernance once with the edited scope and switches", ...)
// PolicyScopePanel
it("shows Inherited from the workspace when policy_scope_source is workspace", ...)
it("Use workspace scope calls the endpoint and is hidden when frozen", ...)
```

- [x] **Step 2: Fail. Step 3: Implement.** Section title "AI governance", placed above `ModelConnectionForm`. **Step 4: PASS, tsc. Commit**

```bash
git commit -am "feat(web): workspace AI governance page; projects inherit scope"
```

### Task 12: Usage and discipline on the governance page

**Files:**
- Create: `apps/web/src/components/workspace/UsagePanel.tsx`, `DisciplinePanel.tsx`, tests
- Modify: `GovernancePanel.tsx`, `api.ts` (`getGovernanceReport`)

- [x] **Step 1: Failing tests**

```ts
it("one line per used source naming its own budget; none when no budget", ...)   // "Managed model: 14 runs, 120,000 tokens; today 8,000 of the daily budget 200,000"
it("table rows per stage with model and tokens", ...)
it("discipline sentences: 12 decisions resolved, 2 open, 1 expired without an answer / Median time to decide: 6 hours / Receipt chains verified for 7 of 7 projects", ...)
it("median absent reads Median time to decide: not yet known", ...)
```

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS. Commit**

```bash
git commit -am "feat(web): AI usage and decision discipline"
```

---

## M2: People

### Task 13: People edges in the overview

**Files:**
- Create: `app/overview/people.py`
- Modify: `app/api/overview.py`
- Test: `apps/cloud/tests/test_overview_people.py`

**Interfaces:**
- Produces: `people.build_links(roles_by_project: dict[str, list[ProjectRole]], tasks: list[TaskSummary], decisions_by_project: dict[str, list[Decision]]) -> list[PersonLinkOut]`.

- [x] **Step 1: Failing tests**

```python
def test_hat_edge_per_role(): ...                                   # kind hat, weight 1, hat name
def test_work_edge_weight_is_task_count(): ...                       # excludes unassigned
def test_approval_edge_requester_to_resolver_weighted(): ...         # only resolved decisions; self never (no self approval exists)
def test_overview_endpoint_carries_people(client, workspace): ...
```

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS, ruff. Commit**

```bash
git commit -am "feat(cloud): people links in the workspace overview"
```

### Task 14: Member side panel

**Files:**
- Create: `apps/web/src/components/workspace/MemberPanel.tsx`, `MemberPanel.test.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/members/page.tsx` (row click selects; `max-w-2xl` → `max-w-5xl` two-column when selected)

**Interfaces:**
- Produces: `<MemberPanel member overview viewerIsAdmin viewerId />`.

- [x] **Step 1: Failing tests**

```ts
it("lists hats per project and projects contributed to", ...)
it("shows decisions waiting on the member only to admins or the member themself", ...)
it("tasks in progress count from work edges and card task_counts", ...)
```

- [x] **Step 2: Fail. Step 3: Implement** (`useOverview` from Task 6; the decisions-waiting list derives from `overview.projects[].decisions` plus `/me/decisions` when the viewer is that member, and from `GET /projects/{id}/decisions` filtered by `routed_hat` for admins). **Step 4: PASS. Commit**

```bash
git commit -am "feat(web): member side panel"
```

### Task 15: Workspace map

**Files:**
- Create: `apps/web/src/components/workspace/WorkspaceMap.tsx`, `layout.ts` (pure: `layoutGraph(members, cards, links, width, height) -> {nodes: Positioned[], edges: Positioned[]}` running `d3-force` to completion with a fixed seed order), `WorkspaceMap.test.tsx`, `layout.test.ts`
- Modify: `apps/web/package.json` (`d3-force`, `@types/d3-force` dev), members page (tab "Map")

- [x] **Step 1: Failing tests**

```ts
// layout.test.ts
it("is deterministic for the same input", ...)
it("places every member and project node inside the viewport", ...)
// WorkspaceMap.test.tsx
it("renders one node per member and project and one path per link, hat solid, work thin, approval dashed with arrow", ...)
it("hover highlights the node's edges; Enter on a focused project node navigates", ...)
```

- [x] **Step 2: Fail. Step 3: Implement** (`forceSimulation(...).stop(); for (let i = 0; i < 300; i++) sim.tick();`; nodes `tabIndex=0` in reading order). **Step 4: PASS, tsc. Commit**

```bash
git commit -am "feat(web): workspace people map"
```

---

## M4: Agents and ask

### Task 16: Agent identity on the artifact

**Files:**
- Modify: `app/models/schemas.py:206` (`TaskStatusArtifact.agent: ArtifactAgent | None`; `ArtifactAgent` and `Artifact.agent` exist since Task 3), `app/api/sync.py:1160`, `app/db/repository.py:519,1543`, `supabase_repository.py` (`upsert_task_artifact(..., agent: ArtifactAgent | None)`), `app/overview/cards.py` (`agent_closed_30d`)
- Test: `apps/cloud/tests/contract/test_artifact_agent.py`, `tests/test_task_status_agent.py`

- [x] **Step 1: Failing tests**

```python
def test_upsert_artifact_merges_agent_once(repo): ...   # first upsert no agent, second with agent → row has agent; third with different client → unchanged
def test_status_patch_with_agent_422_when_too_long(client, project): ...   # client 65 chars → 422 agent_client_too_long
def test_status_patch_records_agent(client, project): ...
def test_card_counts_agent_closed_30d(): ...
```

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS, ruff. Commit**

```bash
git commit -am "feat(cloud): record the agent client that closed a task"
```

### Task 17: MCP server sends its client name

**Files:**
- Modify: `packages/cloud-client/src/types.ts:83` (`StatusArtifact.agent?: {client: string; model?: string}`), `apps/mcp/src/server.ts:460` (after construction, `server.oninitialized = () => writer.setClient(server.getClientVersion()?.name)`), `apps/mcp/src/statusWriter.ts` (`setClient(name: string | undefined)`; every artifact gains `agent: {client: name ? `mcp:${name}` : "mcp"}`)
- Test: `apps/mcp/test/close-task-agent.test.ts`

- [x] **Step 1: Failing test** (InMemoryTransport, client initialised as `{name: "cursor", version: "1"}`): `close_task` PATCH body has `artifact.agent.client === "mcp:cursor"`; without clientInfo name, `"mcp"`.
- [x] **Step 2: Fail. Step 3: Implement. Step 4: `pnpm --dir apps/mcp test` and `typecheck` PASS. Commit**

```bash
git commit -am "feat(mcp): close_task names the MCP client"
```

### Task 18: VS Code extension sends its app name

**Files:**
- Modify: `apps/vscode/src/tasks/statusWriter.ts:17-58` (constructor takes `appName: string`; artifact gains `agent: {client: `vscode:${appName}`}`), its constructor call in `apps/vscode/src/extension.ts` (`vscode.env.appName`)
- Test: `apps/vscode/test/unit/statusWriter.test.ts`

- [x] **Step 1: Failing test:** a write with `appName: "Cursor"` sends `artifact.agent.client === "vscode:Cursor"`.
- [x] **Step 2: Fail. Step 3: Implement. Step 4: `pnpm --dir apps/vscode test` and `typecheck` PASS. Commit**

```bash
git commit -am "feat(vscode): task close names the editor"
```

### Task 19: Show who closed it

**Files:**
- Modify: `apps/web/src/lib/types.ts` (`Artifact.agent`), `apps/web/src/components/project/TaskDrawer.tsx` (artifact line), `apps/web/src/components/workspace/ProjectCard.tsx` (state line "· 7 closed by agents"), tests

- [x] **Step 1: Failing tests**

```ts
it("artifact with agent mcp:cursor reads Closed via Cursor (MCP)", ...)
it("artifact with agent vscode:Cursor reads Closed via Cursor (editor)", ...)
it("artifact without agent reads Closed on the web", ...)
it("card state line appends · N closed by agents when agent_closed_30d > 0", ...)
```

Label mapping: `mcp:<name>` → "<Name> (MCP)", `vscode:<name>` → "<name> (editor)", bare `mcp` → "an MCP client".

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS. Commit**

```bash
git commit -am "feat(web): show which client closed a task"
```

### Task 20: Ask the workspace

**Files:**
- Create: `app/overview/facts.py` (`WorkspaceFacts` model; `compute_workspace_facts(overview: WorkspaceOverviewOut, user_id: str, my_decisions: list[Decision]) -> WorkspaceFacts`; `facts_to_text(facts) -> str`), `app/api/ask.py`, `apps/web/src/components/workspace/AskBox.tsx`, tests
- Modify: `app/main.py`, `app/models/schemas.py` (`GenerationRun.project_id: str | None`), `apps/web/src/app/w/[workspaceId]/page.tsx`

**Interfaces:**
- Produces: `POST /workspaces/{id}/ask` body `{question: str}` (member; question ≤ 500 chars) → SSE: `event: facts` (JSON `WorkspaceFacts`), then `data: {"delta": ...}` tokens, then `event: done`. `WorkspaceFacts(my_open_decisions: list[{project_id, project_name, kind, expires_at}], projects_missing_hats: list[{project_id, name, hats: list[str]}], overdue: list[{project_id, name, count}], by_runtime: dict[str, list[str]], agent_closed_30d: int)`.
- Consumes: `resolve_assistant_models` (`app/rag/models.py`) for the chat connection; `DailyTokenBudget` from `app/rag/budget.py`.

- [x] **Step 1: Failing tests**

```python
def test_facts_my_open_decisions_only_routed_to_me(...): ...
def test_facts_projects_missing_hats(...): ...
def test_ask_without_model_streams_facts_only(client, workspace): ...   # events: facts, done; no delta; generation run row absent
def test_ask_with_fake_provider_streams_deltas_and_records_run(client, workspace): ...  # stage "ask:workspace", project_id None
def test_ask_rejects_long_question(client, workspace): ...               # 422
```

Use the same fake provider fixture `tests/test_assistant_keyless.py` uses.

System prompt (exact): "You answer questions about a software workspace using only the facts provided. If the facts do not contain the answer, say what you do know and what you cannot see. Never invent people, projects or numbers."

```ts
// AskBox.test.tsx
it("shows three example chips and submits the typed question", ...)
it("renders facts as sentences when no delta arrives", ...)   // "You have 2 decisions waiting." etc.
it("streams deltas into the answer", ...)
```

- [x] **Step 2: Fail. Step 3: Implement. Step 4: PASS both suites, ruff, tsc. Commit**

```bash
git commit -am "feat: ask the workspace"
```

### Task 21: Documents and backlog

**Files:**
- Modify: `docs/plans/0029-agent-native-delivery.md` §13 (row 24: "Plan 0033 (2026-10-24 workspace overview and AI governance): cards, people map, workspace policy scope with inheritance, usage and discipline, agent identity on task close, ask box. Its Deferred table holds organisation-custom templates (plan 0023) and guardrail levels (D3)"), this plan's Status line, `CLAUDE.md` Web routes line (members page gains Map; home shows cards), `docs/DEPLOYMENT.md` migration checklist ("0004 through 0011").

- [x] **Step 1: Edit. Step 2: `git diff --stat` shows only docs. Commit**

```bash
git commit -am "docs: plan 0033 shipped; backlog row 24; deployment checklist 0011"
```

---

## Deferred (not in this plan)

| Item | Where it goes |
|---|---|
| Organisation-custom policy templates (`ws:<uuid>`) | Plan 0023 / D5 |
| Guardrail levels, autonomy level, budgets per project; `pw_workspace_governance` migrating into `pw_guardrails` | D3 |
| Run identity beyond `agent.client` (run id, role profile version, model on receipts) | D2 |
| Thai UI strings for the new screens | With a web i18n decision |
| Live updates on the map | Needs the presence backplane |
| Batch the overview and report per-project reads (`list_project_roles`, `list_decisions`, `get_repo_analysis`) into one query per table family, and an RPC for `latest_receipt_at` | Before `develop` → `main` |

## Closing

- [ ] Walkthrough on trust as `kittisak.har` (admin) and `moonrinnn` (member): cards, map, governance page, scope inheritance on a new project, a task closed from Cursor via MCP showing "Closed via Cursor (MCP)", ask box with and without a model connection.
- [ ] Migration 0011 applied to trust Supabase before deploy; `scripts/migrate.py status` prints `Pending (0)`.
- [ ] `gh pr checks` green on the PR into `feature/trust-outcome` before calling it mergeable.

---

## M5: Closing (2026-10-24, after PR #20 merged)

Closes every code and docs follow-up plan 0033 left open, so the Deferred table holds only items owned by other plans. Branch `feature/0033-closing` off `feature/trust-outcome` at `c54a3b7`.

### Task 22: One query per table family in the overview and report

**Files:**
- Create: `apps/cloud/migrations/0012_pw_latest_receipt_at.sql`
- Modify: `apps/cloud/app/db/repository.py` (abstract + memory), `app/db/supabase_repository.py`, `app/api/overview.py` (overview route, `build_overview`, report route)
- Test: `apps/cloud/tests/contract/test_overview_reads.py` (extend), `tests/test_overview_api.py` (extend)

**Interfaces:**
- Produces: `Repository.list_project_roles_for(project_ids: list[str]) -> dict[str, list[ProjectRole]]`, `Repository.list_decisions_for(project_ids: list[str]) -> dict[str, list[Decision]]` (newest first per project, same tolerance as `list_decisions`), `Repository.get_repo_analyses(project_ids: list[str]) -> dict[str, RepoAnalysis]` (only projects with an analysis). Every key for an input id is present in the first two (empty list when none). `latest_receipt_at` on Supabase calls RPC `pw_latest_receipt_at(p_project_ids uuid[])` returning `(project_id uuid, created_at timestamptz)`, falling back to the current paged read when the function is missing (undefined function → SQLSTATE 42883).
- Migration `0012`: `create or replace function pw_latest_receipt_at(p_project_ids uuid[]) returns table (project_id uuid, created_at timestamptz) language sql stable security definer set search_path = public as $$ select project_id, max(created_at) from pw_receipts where project_id = any(p_project_ids) group by project_id $$;` plus `revoke all on function ... from public, anon, authenticated; grant execute on function ... to service_role;`. Header in the 0011 style; idempotent.

- [ ] **Step 1: Failing contract tests** `test_list_project_roles_for_groups_by_project`, `test_list_decisions_for_newest_first_per_project`, `test_get_repo_analyses_only_present`, `test_latest_receipt_at_matches_per_project_max` (seed two projects, three receipts).
- [ ] **Step 2: Fail. Step 3: Implement** on both adapters (Supabase: `in_("project_id", ids)` with `_paged`; roles table `pw_project_roles`, decisions `pw_decisions` with the existing snapshot/`DeliveryStoreUnavailable` tolerance factored so `list_decisions(project_id)` delegates to `list_decisions_for([project_id])[project_id]`; analyses `pw_repo_analyses`). Overview and report routes read each family once; `get_repo_analysis`, `list_project_roles`, `list_decisions` are no longer called inside the per-project loop. Add `test_overview_reads_each_family_once` using a counting wrapper around the memory repository (`unittest.mock.patch.object` with `wraps=`) asserting each of the three batched methods is called exactly once and the per-project methods zero times.
- [ ] **Step 4: PASS, ruff. Commit** `feat(cloud): overview and report read one query per table family; receipts RPC`

### Task 23: RLS probe for the governance table

**Files:**
- Create: `apps/cloud/tests/rls/test_governance_table_grants.py`

- [ ] **Step 1: Write the probe** in the style of `tests/rls/test_tracker_integration_grants.py` using `Fixture`, `Target`, `INSUFFICIENT_PRIVILEGE` from `tests/rls/conftest.py`: `test_member_cannot_read_workspace_governance` (member JWT `GET /rest/v1/pw_workspace_governance?workspace_id=eq.<ws>` → SQLSTATE 42501) and `test_member_cannot_write_workspace_governance` (member JWT `POST` a row → 42501; service-role read shows no row). The file skips, naming the missing variable, without the `PROMPTWORKSPACE_RLS_*` env.
- [ ] **Step 2: Run** `pytest tests/rls/test_governance_table_grants.py -q` → skipped locally with the variable named. **Commit** `test(cloud): RLS probe for pw_workspace_governance`

### Task 24: Cloud polish from the review ledger

**Files:** `app/overview/checks.py`, `app/overview/cards.py`, `app/models/schemas.py` (`TaskSummary.agent_closed_at: datetime | None`), `app/db/repository.py` + Supabase (`list_tasks_summary` fills `agent_closed_at` = max `updated_at` of the task's agent artifacts), `app/overview/report.py`, `app/generation/managed.py`, `app/api/overview.py`; tests alongside.

- [ ] Hat checks iterate `("business_owner", "tech_steward")` filtered by `required_hats` (spec order), test with `required_hats` reversed.
- [ ] `agent_closed_30d` windows on `agent_closed_at`, not the task's `updated_at`; test: task edited today but agent-closed 40 days ago → 0.
- [ ] Report: "today" compares `created_at.astimezone(timezone.utc).date()`; `MANAGED_PROVIDER = "typhoon"` constant exported from `app/generation/managed.py` and used by the report; `by_stage.model` lists distinct models joined by ", " when a stage used more than one; tests.
- [ ] Governance PUT: the "Applies to N projects" count the web shows comes from the overview, so expose `inheriting_unfrozen: int` and `own_scope: list[str]` (names) in `GET /workspaces/{id}/governance` so the web stops deriving it; test.
- [ ] Commit `fix(cloud): check order, agent-closed window, usage report details`

### Task 25: Web polish from the review ledger

**Files:** `src/app/w/[workspaceId]/page.tsx`, `src/components/workspace/{UsagePanel,MemberPanel,WorkspaceMap,GovernancePanel}.tsx`, `src/lib/agentLabel.ts`, tests alongside.

- [ ] Home: when `overview.truncated`, a line "Showing the 200 most recently updated projects."
- [ ] UsagePanel: empty usage → "No AI runs in the last 30 days." under the heading; `<th scope="col">`.
- [ ] MemberPanel and WorkspaceMap: names through `memberFullName` (never a raw id); "In progress" heading → "Assigned".
- [ ] GovernancePanel: "Applies to N projects. M projects use their own scope." from the new governance fields (frozen inheriting projects excluded from N).
- [ ] `agentLabel`: `vscode:` with an empty name → "Closed via an editor".
- [ ] Tests for each; capped vitest; tsc. Commit `fix(web): truncation notice, empty usage state, names, assigned heading`

### Task 26: Close the plan

**Files:** this plan (Deferred table, Status), `docs/DEPLOYMENT.md` (0012 sentence; checklist "0004 through 0012"; smoke-check `schema_version` → `0012_pw_latest_receipt_at`), `.gitignore` (`.worktrees/`), `docs/plans/0029-agent-native-delivery.md` row 24 ("Deferred" → "no open items; other-plan items listed there").

- [ ] Deferred table keeps only rows owned by other plans, each reworded "Owned by <plan>; not a follow-up of this plan". Status: "Implemented 2026-10-24 (M1 to M5). Closing checklist: trust walkthrough pending."
- [ ] Commit `docs: plan 0033 closed; migration 0012 in deployment checks`
