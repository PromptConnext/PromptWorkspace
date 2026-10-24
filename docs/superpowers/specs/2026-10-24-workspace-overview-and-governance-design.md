# Workspace overview and AI governance: design

**Date:** 2026-10-24. **Status:** Approved by the user 2026-10-24 (names: option B, `display_name`). **Branch:** `feature/workspace-overview`, cut from `feature/trust-outcome` at `2065f76`; merges back into `feature/trust-outcome`, which the trust environment deploys. **Plan:** 0033 (to be written from this design).

## Intent

After the 2026-10-24 presentation the CEO said two things about PromptWorkspace: the platform "does not touch the people", and it must be as easy to use as talking to an AI. He also asked for **product taste**: a product that makes its own good choices instead of showing every option.

Today a workspace is a list of project names. A Tech Lead cannot see who works where, who decides for whom, what each project is built with, or whether the projects follow the workspace's AI and compliance rules. All of that data already exists in the cloud; nobody shows it.

This feature gives a Tech Lead one place that answers, in the first five seconds, "who is doing what, with what, and are we following our own rules". It is the workspace-level altitude of the project screens in plan 0029 §5.3 (Mission Control, Guardrails, Agents, Audit trail), not a separate dashboard product.

## Goals

1. **People first.** The workspace home shows every project as a card that leads with its people: the business owner, the tech steward, and the members who actually work on it. A person is a face and a name, never a user id.
2. **Project insight at a glance.** Each card also shows what the project is built with (runtime, languages), what state it is in (tasks by status, open decisions, live URL) and when it last moved.
3. **A people map.** A member page and a workspace map show who is attached to which projects and how work and approvals flow between people.
4. **Workspace-wide AI governance.** The workspace, not each project, declares its policy scope and its baseline rules. Projects inherit it and may adjust it. The Tech Lead sees which projects deviate, which lack a steward, which have drifted from their seeded rules, how much AI generation runs and on which models, and how disciplined approvals are.
5. **Ask, do not browse.** A question box on the workspace home answers questions such as "who is waiting on me?" or "which projects have no tech steward?" from the same facts the cards show.
6. **Agent work is visible.** When an agent closes a task through the MCP server or the editor, the card and the task say so, and name the client it came through.

## Non-goals

- Enforcing anything. This feature shows governance posture; it blocks nothing. Enforcement (gate, Evidence Pack, lane matrix) is milestone D3 of the umbrella v2.1 plan.
- Organisation-custom policy templates (`ws:<uuid>` ids, plan 0023). The workspace scope selects from the six built-in templates plus custom text, the same shape projects use today.
- Guardrails with levels (prompt/check/gate), autonomy levels, budgets per project (plan 0029 §5.4). The workspace governance row is the seed `pw_guardrails` will grow from in D3, not a first version of it.
- Time-series analytics, cost in money, per-person productivity scores.
- Recording what an agent did inside the editor (traces, tokens). Only the fact that a close came through an agent client, and which one.
- Replacing the project-level Policy Scope panel. It stays; it changes from "pick templates" to "inherit from the workspace, adjust if you must".
- Thai UI strings. The web UI is English today; this feature follows the existing convention. (The workspace language still governs LINE messages and generated content.)

## Anti-goals (a failure even if it technically works)

- **A dashboard.** Tiles of numbers with no people on them. If the first thing on a card is a count, the design failed.
- **A settings maze.** Governance becomes more than one page with more than a handful of controls. Product taste means fewer choices with better defaults.
- **A ranking of people.** Nothing here orders members by output, tokens or speed. The people map shows attachment and flow, not performance.
- **A lying checklist.** A project shows "compliant" when all the platform knows is that a template was ticked. Every check names exactly what was verified.
- **A slow home page.** The workspace home must not get slower than today by more than one aggregate request; nothing on it calls GitHub.
- **Member data leaking.** A member sees people and projects they can already see today. Token usage and governance settings are admin-only.

## Product taste: the rules this feature follows

These are decisions, not aspirations. A reviewer may reject a change against any of them.

1. **Default view is the answer.** No filters, no configuration, no "customise your dashboard". The Tech Lead sees the right things because we chose them.
2. **One number per concern.** A card shows open decisions, tasks in progress, tasks done. Not twelve metrics. Details live one click away.
3. **People are rendered as people.** Avatar, full name, hat. Existing `Avatar`, `MemberChip` and `RoleBadge` components, no new visual language.
4. **Quiet when fine, loud when not.** A compliant project shows a small green check. A project with no tech steward shows a yellow line that says so in words, with the one action that fixes it.
5. **Words over icons.** Every state is a sentence a non-technical CEO can read: "No tech steward assigned", "Rules in the repository differ from the plan", "2 decisions waiting for Somchai".
6. **The question box uses the same facts as the cards.** It never knows something the page does not, and it never invents. When it cannot answer, it says what it can answer.

## What exists today (verified 2026-10-24 on `feature/trust-outcome`)

| Need | Already in the cloud | Where |
|---|---|---|
| Workspace members and roles | `pw_workspace_members` (admin/member; `email` nullable, added at `0002:790`; no display name anywhere) | `apps/cloud/migrations/0002_pw_baseline.sql:178`, `GET /workspaces/{id}/members` |
| Project hats | `pw_project_roles` (business_owner, tech_steward) | `0004:57`, `GET /projects/{id}/roles`, `ProjectRolesPanel.tsx` |
| Who works on what | `pw_tasks.assigned_user_id` (text, added `0002:969`), `pw_tasks.status` | `0002:81`, graph read `GET /sync/projects/{id}/graph` |
| Who decides for whom | `pw_decisions` (requested_by, resolved_by, routed_hat, status, expires_at) | `0004:67`, `0009` |
| Audit trail | `pw_receipts` hash chain (decision and role events, actor) | `0007:26`, `GET /projects/{id}/receipts` |
| Tech stack | `pw_repo_analyses.snapshot.stack` {runtime, manifests, languages} | `schemas.py:1451`, `GET /projects/{id}/repo-analysis` |
| Policy scope | `pw_projects.policy_scope` {selected, custom_text}; six built-in templates | `schemas.py:481`, `policies.py:51`, `PolicyScopePanel.tsx` |
| Rules seeded to the repo and drift | AGENTS.md, conventions, constitution; `GET /projects/{id}/repository/docs-status` | `repo_seed.py:14-20`, `repository_docs.py:219` |
| AI generation usage | `pw_generation_runs` (stage, model_source, model, tokens, created_at) | `0002:868`, `schemas.py:1428`; create/update only, no list |
| Model connection and budget | `pw_workspace_model_connections.daily_token_budget` | `0002:535` |
| Live URL | `pw_projects.deployment_state` | `0002:1352` |
| Commit that closed a task | `pw_artifacts` (commit_sha, uri) via `PATCH .../tasks/{id}/status`; upsert is idempotent on (task_id, commit_sha) | `schemas.py:206`, `sync.py:1160`, `repository.py:1543` |

Missing: any workspace-wide aggregate endpoint; a list method for generation runs; a workspace-level policy scope; any record of which client (agent or person) closed a task; any chart or graph library in `apps/web`.

## Design

### 1. Workspace home becomes project cards (M1)

`apps/web/src/app/w/[workspaceId]/page.tsx` keeps its header (name, New project, members stack, Inbox, Settings) and replaces the project list with a responsive grid of cards. Layout widens from `max-w-3xl` to `max-w-6xl`.

One card, top to bottom:

1. **Project name**, with the "Live" pill and link when deployed (unchanged behaviour).
2. **People row.** Business owner and tech steward as `MemberChip` with a small hat label; when a hat has no holder, the chip reads "No tech steward" in amber and links to project settings (admins) or is plain text (members). Then up to five contributor avatars (members with at least one task assigned on this project) and "+N".
3. **Stack line.** Runtime and up to three languages as small neutral badges, from the latest repo analysis. When there is no analysis: "Not analysed yet" in muted text. Nothing else; manifests are not shown.
4. **State line.** Three words with numbers: "3 in progress · 12 done · 2 decisions waiting". Decisions waiting links to the project's Decisions tab. An open decision past its expiry (the window before the sweep moves it to `expired`) turns the count amber: "1 decision overdue". A decision the sweep already expired in the last 30 days reads "1 decision expired without an answer", also amber, because the requester must ask again.
5. **Governance line.** One sentence from the compliance checks (§4). Green check and "Follows workspace rules" when all pass; otherwise the first failing check's sentence in amber, e.g. "Policy scope differs from the workspace".
6. **Last activity**: "Updated 2 hours ago" from the newest of the project's `updated_at`, latest receipt and latest task `updated_at`.

Members see every project in the workspace (same visibility as the current list). Nothing on a card requires admin.

Empty workspace keeps the current empty state.

### 2. The overview endpoint (M1)

`GET /workspaces/{workspace_id}/overview`, guard `require_workspace`. One request returns everything the cards need:

```
WorkspaceOverviewOut
  workspace_id
  generated_at
  members: [{user_id, email, display_name, role}]           # display_name per §7
  projects: [ProjectCardOut]
  people: [PersonLinkOut]                                    # M2, see §3

ProjectCardOut
  id, name, lifecycle_status, live_url | null, updated_at
  hats: {business_owner: user_id | null, tech_steward: user_id | null}
  contributors: [user_id]                                    # distinct assigned_user_id on tasks, most tasks first
  task_counts: {todo, in_progress, implemented, verified}
  decisions: {open, overdue, expired_30d}                    # overdue = open past expires_at; expired = swept to `expired` in the last 30 days
  stack: {runtime, languages[:3]} | null
  policy: {source: "workspace" | "project", selected: [...]} # §4
  checks: [{id, ok, text}]                                   # §4, computed; excludes the repo-drift check
  last_activity_at
```

Implementation: one `list_projects_by_workspace`, then per project `list_project_roles`, `list_decisions`, `get_repo_analysis`. Two repository methods are added on both adapters: `list_tasks_summary(project_ids)` (status, assignee, agent flag per task, one grouped query) and `latest_receipt_at(project_ids)`. `pw_tasks.assigned_user_id` and `pw_project_roles.user_id` are `text` while `pw_workspace_members.user_id` is `uuid`; the Supabase adapter casts when joining and the API compares as strings. Cap: the endpoint serves workspaces with up to 200 projects in one response; beyond that it returns the first 200 ordered by `updated_at` and `truncated: true`. (My call; no workspace is near that today.)

The repository-drift check is **not** in this endpoint because it calls GitHub. The card fetches `GET /projects/{id}/repository/docs-status` lazily, only for projects in `repo_created`, with the existing `useCloudGet`, and the governance line updates when it arrives.

### 3. People map (M2)

**Member page** (`w/[workspaceId]/members/page.tsx`) gains a side panel when a member is selected: their hats per project, projects they contribute to, tasks in progress, decisions waiting on them (from `/me/decisions` logic generalised to any user for admins; for a member viewing another member, only hats and projects are shown, no decision queue). The panel reads from the overview's `people` section.

**Workspace map** is a new tab on the members page, "Map". A force-directed graph with `d3-force` (ISC licence, confirmed acceptable by the user 2026-10-24) and hand-written SVG; no `d3-selection`, no React wrapper library. Nodes: members (avatar) and projects (folder). Edges:

- member → project, **hat** edge (solid, labelled by hat colour) when the member holds a hat there;
- member → project, **work** edge (thin) weighted by tasks assigned;
- member → member, **approval** edge (dashed, arrow) when one has resolved a decision the other requested, weighted by count.

`people` in the overview carries exactly these edges precomputed server-side:

```
PersonLinkOut
  kind: "hat" | "work" | "approval"
  from_user_id, to_user_id | null, project_id | null, hat | null, weight
```

The map is static per load (no live updates), supports hover to highlight a node's edges, and click to open the project or member panel. It is drawn with simulation ticks run to completion before first paint (no animation), so it is deterministic in tests. Keyboard: nodes are focusable in reading order; Enter opens.

### 4. Workspace governance (M3)

#### 4.1 Policy scope moves to the workspace

Decided by the user 2026-10-24: the workspace declares the policy scope; projects start from it and may adjust it.

Storage: new table `pw_workspace_governance`, one row per workspace, created on first read if absent:

```
workspace_id          pk, fk pw_workspaces
policy_scope          jsonb  {selected: [...], custom_text: ""}   default empty
required_hats         text[] default '{business_owner,tech_steward}'
require_seeded_rules  boolean default true
updated_at, updated_by
```

Project side: `pw_projects.policy_scope` stays the **effective** scope that generation reads (`generation.py:602 _policy_block` is unchanged). A new column `pw_projects.policy_scope_source text not null default 'project'` with values `workspace` or `project` records where it came from.

Behaviour:

- A new project copies the workspace scope at creation and sets source `workspace`.
- Editing the workspace scope rewrites `policy_scope` on every project of that workspace whose source is `workspace` and whose lifecycle is not `repo_created` (the existing freeze rule holds). Frozen projects keep what they were seeded with; the governance check reports the difference.
- Editing a project's scope (existing `PATCH /projects/{id}/policy-scope`) sets source `project`. The project panel gains **Use workspace scope**, which copies the workspace scope back and sets source `workspace`.
- Migration backfill: existing projects keep their scope with source `project`. A workspace with no governance row gets one with an empty scope; admins set it once. (My call: backfilling the workspace scope from the most common project scope would guess; an empty default and one admin action is honest.)

API: `GET /workspaces/{id}/governance` (member) returns the stored row or the code default when none exists; it never writes. `PUT /workspaces/{id}/governance` (admin, full replace, same validation as the project route: known template ids, custom text cap) inserts or updates the row. Receipts stay per project (`pw_receipts` is keyed `(project_id, seq)` with `subject_type in ('decision','project_role')`): a workspace scope change writes one receipt into the chain of **each project whose scope it rewrote**, event `policy_scope.updated`, new `subject_type = 'project_policy'` (the check constraint and the `ReceiptDraft` literal widen in migration 0011), body `{source: "workspace", before, after, actor}`. Projects that keep their own scope get no receipt. The workspace row itself records `updated_by` and `updated_at` only; there is no workspace-level chain.

#### 4.2 Governance page

Workspace settings (`w/[workspaceId]/settings/page.tsx`), admin-only section **AI governance**, placed above Model connection:

1. **Policy scope** — the same checkbox list and textarea `PolicyScopePanel` uses, lifted into a shared component with a `scopeOf` prop. Below it: "Applies to N projects. 2 projects use their own scope." with the two named.
2. **Baseline rules** — two switches: "Every project needs a business owner and a tech steward" (hats) and "Every project's repository must carry its rules" (seeded rules). Defaults on. That is the whole control surface.
3. **Projects** — one row per project with its check results as sentences (§4.3), amber when failing, each with the link that fixes it.
4. **AI usage, last 30 days** — one short table: stage, runs, model, source (byo / managed), tokens. Above it one line per source that was used, each naming its own budget: "Managed model: N runs, M tokens; today P of the daily budget B" (B is the global `managed_daily_token_budget`, ADR 0027) and "Your model (provider): N runs, M tokens; today P of B" (B is the connection's `daily_token_budget`). A source without a budget shows no budget clause. Never one combined budget line. Admin-only. Needs `Repository.list_generation_runs(workspace_id, since)` on both adapters.
5. **Decision discipline** — three sentences: "12 decisions resolved, 2 open, 1 expired without an answer", "Median time to decide: 6 hours", "Receipt chains verified for 7 of 7 projects" (verification reuses the chain check in `receipts.py`, run per project). No charts in v1.

#### 4.3 Compliance checks (computed, never stored)

| id | Sentence when failing | Verified by |
|---|---|---|
| `hat_business_owner` | No business owner assigned | `pw_project_roles` has no row for the hat (only when `required_hats` includes it) |
| `hat_tech_steward` | No tech steward assigned | same |
| `policy_matches_workspace` | Policy scope differs from the workspace | project `selected` set ≠ workspace `selected` set (custom text is not compared); only reported when the workspace scope is non-empty |
| `policy_empty` | No policy scope set | both project and workspace scopes empty |
| `decisions_overdue` | N decisions past their due date | `pw_decisions.status = open` and `expires_at < now`, plus `status = expired` with `resolved_at` in the last 30 days |
| `rules_in_repo` | Rules in the repository differ from the plan | `docs-status` has any file not `in_sync` (client-side, `repo_created` only, when `require_seeded_rules`) |

Order matters: the card shows the first failing check in this order. All pass: "Follows workspace rules".

### 5. Agent identity on task close (M4)

`TaskStatusArtifact` gains an optional `agent: {client: str, model: str | None}`. Stored in a new `pw_artifacts.agent jsonb` column. Validation: `client` ≤ 64 characters, `model` ≤ 128; anything longer is rejected with 422.

- The MCP server reads the client name after the initialize handshake through the SDK's `server.getClientVersion()` (`apps/mcp/src/server.ts`, where the `Server` is constructed) and passes it into `apps/mcp/src/statusWriter.ts`, which sends `client` as `mcp:<name>` (e.g. `mcp:cursor`, `mcp:claude-code`), else `mcp`. New plumbing, not a one-liner. It does not know the model; `model` is omitted.
- The VS Code extension (`apps/vscode/src/tasks/statusWriter.ts`) sends `client: vscode:<appName>` (e.g. `vscode:Cursor`) from `vscode.env.appName`.
- Web drag-to-status sends nothing. Absence means a person did it from the web.

The GitHub push webhook (ADR 0022) may create the artifact for the same `(task_id, commit_sha)` before the editor's PATCH arrives. `upsert_task_artifact` therefore merges: when the stored row has no `agent` and the incoming one does, the row gains it; a stored `agent` is never overwritten by a different one. Both adapters implement this and the contract suite pins it.

Display: the task drawer's artifact line reads "Closed via Cursor (MCP)" or "Closed on the web"; the project card's state line gains "· 7 closed by agents" when any artifact in the last 30 days carries `agent`. Overview adds `agent_closed_30d` per project.

This is a strict subset of D2's "run identity" (run id, role profile version, model on every receipt). D2 extends the same column.

### 6. Ask the workspace (M4)

A single input on the workspace home above the cards: "Ask about this workspace". Submits to `POST /workspaces/{id}/ask` (member), which:

1. Computes `WorkspaceFacts` deterministically from the overview data for the asking user: their open decisions, projects missing hats, overdue decisions, projects by runtime, agent-closed counts. Sent first as an SSE `facts` event (same pattern as `LineageFacts` in project assistant chat, `schemas.py:1069`).
2. Narrates an answer with the same model resolution the RAG assistant uses (`api/assistant.py`: the workspace's BYO connection, else the managed tier), with the facts as the only context and a system prompt that forbids inventing. Streams as `token` events. When neither source is available, the facts are rendered as sentences by the web and no model is called. The run draws on the budget of whichever source answered.

The box has three example chips: "Who is waiting on me?", "Which projects have no tech steward?", "What did agents close this week?". No thread history, no memory, no RAG index. A `pw_generation_runs` row is written with stage `ask:workspace` and `project_id` null, so usage shows up in §4.2; migration 0011 makes `pw_generation_runs.project_id` nullable (it is `not null` today, `0002:875`).

## Constraints

- Every change lands with a test that fails first. Cloud tests hermetic (`DATA_BACKEND=memory`), both repository adapters implement any new method, the Supabase adapter is exercised by the contract suite where one exists. Web: `tsc --noEmit`, `vitest run`.
- Cloud: `ruff check .`, line length 100. Web: existing Tailwind conventions; no shadcn, no new design tokens.
- Migration `0011_pw_workspace_governance.sql`: idempotent, header in the style of `0010`; the new table is service-only (RLS enabled, no policy, grants revoked) because governance is read through the API. Also in 0011: `pw_projects.policy_scope_source`, `pw_artifacts.agent jsonb`, `pw_workspace_members.display_name` (§7), `pw_generation_runs.project_id` dropped to nullable, and the `pw_receipts.subject_type` check widened to include `project_policy`. Apply before deploying.
- `GET /workspaces/{id}/overview` must answer a 20-project workspace in under 500 ms against the memory adapter and must issue at most one query per table family (projects, roles, tasks summary, decisions, repo analyses, latest receipts) against Supabase. No GitHub call.
- `d3-force` is the only new runtime dependency in `apps/web`.
- The question box never sends document text, discussion bodies or decision snapshots to the model. Only the facts structure.
- No `BackgroundTasks` for anything on a request path (N3 lesson).

## Milestones and order

| M | Ships | Migration | Est. |
|---|---|---|---|
| M1 | Overview endpoint, project cards, lazy drift check on cards | none | 4 days |
| M3 | Governance table, scope inheritance, governance page, usage and discipline, compliance checks, receipt event | 0011 | 5 days |
| M2 | Member side panel, workspace map (`d3-force`) | none | 4 days |
| M4 | Agent identity on close, Ask the workspace | 0011 (same file, applied once) | 3 days |

M1 then M3 first: together they answer both of the CEO's remarks. M2 and M4 follow. The migration file is written in M3 and gains the M4 columns before the branch merges, so each environment applies one migration.

## 7. People have names (M1)

No display name exists in the cloud or in Supabase Auth today; `memberFullName` returns the email. The CEO's remark is about people, and a card of emails is not people.

**Decided by the user 2026-10-24: option B.** The two options considered:

- **A. Email stays the name in v1.** Zero schema change; consistent with plan 0032's LINE copy. Cards show the email local part in chips and the full email on hover.
- **B. Add `display_name`** (my recommendation). `pw_workspace_members.display_name text null`; `PATCH /workspaces/{id}/members/me` lets a member set their own, admins may set anyone's; `/members` and the overview return it; `memberFullName` prefers it and falls back to the email. The members page gets one inline field ("Your name"). Avatars stay initials, now from the name. LINE copy keeps using the email (plan 0032 decided that; not reopened here).

The design assumes B throughout.

## Left to the builder

- Card grid breakpoints, badge colours within the existing slate/emerald/amber palette, exact avatar sizes.
- Force simulation parameters and node sizes in the map.
- The system prompt wording for Ask, within the constraint above.
- Whether `list_tasks_summary` is a view or a grouped query in Supabase.
- Test fixtures for a workspace with mixed hats, scopes and frozen projects.

## 8. Calls I made (for the user to check while reading)

1. Governance row defaults to an empty scope; no backfill guess from projects. GET never writes; PUT inserts or updates.
2. Custom policy text is not compared in the "differs from workspace" check.
3. Drift check stays client-side and lazy, not in the overview endpoint.
4. The people map runs its simulation to completion before paint; no animation.
5. Token usage and governance settings are admin-only; cards and the map are for all members.
6. The Ask endpoint is facts-first, uses the assistant's model resolution, and works without any model.
7. Receipts stay per project; a workspace scope change fans out one `policy_scope.updated` receipt per rewritten project. No workspace chain.
8. "Overdue" covers both open-past-expiry and swept-to-expired within 30 days; the sentence differs.
9. Budgets are shown per source (managed global budget vs BYO connection budget), never combined.
10. `upsert_task_artifact` merges a missing `agent` into an existing row and never overwrites a present one.

## 9. Questions the user answered

1. Names: option B, `display_name` (2026-10-24). See §7.
