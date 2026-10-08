# Trust-Test Findings Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. This is the **master plan**: triage, waves, tasks with files, interfaces and named acceptance tests. Each wave gets its own step-by-step TDD plan (with code) written by `superpowers:writing-plans` **when that wave starts**, from the code as it is then — a TDD plan written now for wave 5 would be stale by the time wave 1 lands.

**Goal:** Close the open findings from the Marketing Studio end-to-end test on the trust environment, in the order and grouping that costs the least.

**Architecture:** Five waves of work split by directory so independent waves run in parallel (web+cloud approvals, VS Code extension, cloud generation), plus one config wave that needs no code. Latency work is measure-first. One reviewer per wave, one live smoke per wave on the two existing test projects.

**Tech Stack:** FastAPI + Supabase adapters (`apps/cloud`), Next.js 16 / vitest (`apps/web`), VS Code extension + `packages/cloud-client` + `apps/mcp` (node `--test`), migrations in `apps/cloud/migrations`.

**Spec:** 57 findings in `.superpowers/sdd/2026-10-04-trust-outcome-m1-m2/marketing-studio-findings.md` (git-ignored; row numbers below are its `#`), and plan 0029 (`docs/plans/0029-agent-native-delivery.md`).

## Global Constraints

- Branch `feature/trust-outcome`; never rebase it. Every fix has a test that fails on the old code (RED check before commit).
- Cloud: `source .venv/bin/activate` per command (shell state does not persist); `python -m pytest -q` and `ruff check .` clean (line length 100). Web: `pnpm typecheck` and `pnpm exec vitest run`. Editor packages: `node --test` via `pnpm --dir <pkg> test` and `pnpm --dir apps/vscode typecheck`.
- A new migration is applied to the database **before** the code that needs it, or the code tolerates its absence (the 0003 pattern). Never commit secrets; the trust Supabase URL/keys stay out of the repo.
- Task refs, the ref grammar and the status vocabulary `todo | in_progress | implemented | verified` do not change.
- Text from repositories and documents is rendered as text, never as HTML.

## Review Focus

- **Decision requested before migration 0006 is applied** (task 1.1): the API must still answer `/decisions` and accept requests, with no snapshot content, rather than 500.
- **Diff on a 12 KB document** (1.1): the line diff must stay fast and render hostile markdown as plain text.
- **Regeneration with an unchanged or reworded title** (4.1): identical titles must not churn into retire-and-insert, and a closed task's evidence must survive on the retired row.
- **An SSH alias that could match two projects** (3.2): a host-alias match that is ambiguous must refuse to link, never pick one.
- **Refresh lease with a crashed holder** (3.6): the lease must expire so one dead window cannot stop everyone refreshing.

---

## Triage

| Status | Findings |
|---|---|
| **Done** (commits on the branch) | #1 import of fresh repo · #20 service_role grants (0005) · #21 #22 #29 brownfield tasks · #39 #45 #46 #48 session loss · #40 #43 lost closes · #49 |
| **Passed, no action** | #30 #34 #47 #52 #53 |
| **Config / user steps** | #3 #24 APP_ENV · #19 #26 region (wave 0) |
| **In waves** | everything else, mapped at the end |
| **Deferred, with reason** | #23 waves ignore file overlap (needs a product call on what a wave means) · #32 deployment template menu (product scope) · #50 b/c/d (held-entry cap, retroactive close, rotated-pair adoption: no incident, no evidence) |

## Waves and order

```
Wave 0  config (anytime)                      ─┐
Wave 1  approvals (web + cloud)  ─► Wave 2 speed ─► Wave 5 delivery view   (shared files: delivery.py, DecisionsPanel, ApprovalControl)
Wave 3  VS Code extension + cloud-client     (parallel with 1/2/4: disjoint files)
Wave 4  generation quality + data integrity  (parallel with 1/2/3: apps/cloud/app/generation, imports)
```

Critical path is 1 → 2 → 5. Waves 3 and 4 run beside it with their own implementer. Highest value first inside each wave.

## Efficiency rules

1. **Batch per wave, not per task.** One implementer subagent per wave (mid-tier model; opus only for 2.3, 3.4 and the 4.2 spike, which need design judgment), one task-level review at the end of the wave plus a scoped re-review of fixes. Prompt-only and copy-only tasks (4.3, 4.4, 5.3) are reviewed with the rest of their wave, not separately.
2. **Measure before optimizing** (2.1). The region move (wave 0) may remove most of the latency; stop wave 2 at task 2.2 if page loads are under 3 s after it.
3. **One live smoke per wave**, reusing the existing test projects: the finished Marketing Studio project (extension, approvals) and `marketing-studio-check` (generation). No new test projects.
4. **Pure logic goes in small modules** so it is unit-testable without an editor or a database (the `publication.ts` / `path_check.py` pattern); the thin editor/route glue is checked by the smoke.
5. **Cut early:** the deferred list above, and any task whose measured effect is nil.

Rough size: 30 tasks, about 14 commits, 4 reviews. Waves 1, 3 and 4 are each about a day of agent time; 2 and 5 half a day each.

---

## Wave 0: configuration (no code)

### Task 0.1: `APP_ENV=trust` (#3, #24)
- **Owner:** you, in Northflank → trust service → runtime variables.
- **Done when:** `curl https://promptworkspace-trust-api.truthledgers.com/health` shows `"env":"trust"`.

### Task 0.2: privilege check on staging and production (#20 follow-through)
- **Owner:** you run, I read the output.
- Run `psql "$POOLER_URL" -c "select has_table_privilege('service_role','public.pw_workspace_members','select,insert,update,delete')"` against each. `t` is fine. On `f`, apply migration 0005 (`scripts/migrate.py apply`) before the next deploy of this branch there.

### Task 0.3: move the API next to Supabase (#19, #26, #10 root)
- **Owner:** you; steps in `docs/DEPLOYMENT.md` "Region". Open points to check in Northflank: a Singapore-area region on your plan, one custom domain on two services during the switch, certificate issuance at the CNAME switch.
- **Done when:** the timing snippet in 2.1 shows `GET /decisions` under 0.8 s from the browser.

### Task 0.4: remove the disposable check project
- Delete GitHub repo `PromptConnext/marketing-studio-check` and the project "Marketing Studio (brownfield check)" after wave 4's smoke.

---

## Wave 1: approvals you can trust (#9 #10 #11 #12 #17 #18 #25)

Value: the governance moment is the product's core, and today an approver signs off without seeing the document.

### Task 1.1: show what is being approved, and what changed (#11)

**Files:**
- Create: `apps/cloud/migrations/0006_pw_decision_subject_content.sql`; `apps/web/src/lib/lineDiff.ts`; `apps/web/src/components/project/DecisionSubject.tsx`
- Modify: `apps/cloud/app/models/schemas.py` (`Decision.subject_content: str | None = None`), `apps/cloud/app/api/delivery.py` (`request_decision` stores the document text; `DecisionOut` carries it), both repository adapters (`save_decision`/`list_decisions` read and write the column, tolerating its absence), `apps/web/src/lib/types.ts`, `apps/web/src/components/project/DecisionsPanel.tsx`
- Test: `apps/cloud/tests/test_decisions_api.py`, `apps/cloud/tests/test_delivery_store_adapter.py` (contract, both adapters), `apps/web/src/lib/lineDiff.test.ts`, `DecisionSubject.test.tsx`

**Interfaces:**
- Produces: `Decision.subject_content` (document text at request time, `None` for decisions made before 0006); `lineDiff(before: string, after: string): DiffLine[]` with `DiffLine = {kind: "same"|"add"|"del"; text: string}`; `<DecisionSubject decision previous />` where `previous` is the newest earlier *approved* decision of the same kind.

**Acceptance tests (named):**
- `test_a_request_stores_the_document_it_asks_to_approve`
- `test_decisions_still_answer_without_the_content_column` (migration not applied)
- `lineDiff` unit cases: identical, pure add, pure delete, reorder, 500-line document under 50 ms
- `DecisionSubject renders hostile markdown as text` and `shows the diff against the last approved version`, `shows the full text when nothing was approved before`.

### Task 1.2: resolved cards say who and when (#12)
- **Files:** `DecisionsPanel.tsx` (+ test). It already loads workspace members; map `resolved_by` to a name and format `resolved_at`.
- **Acceptance:** `a resolved decision shows the resolver's name and time`; unknown member falls back to "a former member".

### Task 1.3: superseded approvals are labelled (#18)
- **Files:** `apps/cloud/app/api/delivery.py` (`DecisionOut.is_current: bool`, true when `subject_hash` equals the current hash of its stage, from the hashes the list route already reads), `types.ts`, `DecisionsPanel.tsx`.
- **Acceptance (cloud):** `an approval made before an edit reads is_current false`; **(web):** `a superseded approval shows "Superseded by edit", not plain "Approved"`.

### Task 1.4: loading, retry and transient-failure handling (#10, #25, #13 client half)
- **Files:** `apps/web/src/lib/hooks.ts` (`useCloudGet` returns `retry`, existing `refetch` reused), `apps/web/src/lib/api.ts` (`apiFetch` retries a GET once, 400 ms later, on a network error or 502/503/504; never a write), `DecisionsPanel.tsx`, `ApprovalControl.tsx`, `DeliveryPlan.tsx` (a loading line and an error line with a **Retry** button).
- **Acceptance:** `a failed GET is retried once`; `a POST is never retried`; `an error state shows Retry and clicking it refetches`; `the Decisions tab shows a loading line, not a blank page`.

### Task 1.5: inbox card and approval chip (#9, #17)
- **Files:** `apps/web/src/app/w/[workspaceId]/inbox/page.tsx` (whole card is the link), `ApprovalControl.tsx` (when a document save lands while the state is `approved`, flip to `stale` locally at once, then refetch).
- **Acceptance:** `clicking anywhere on an inbox card navigates`; `saving an approved document shows "Changed since approval" before the refetch resolves`.

**Wave 1 smoke:** on the Marketing Studio project, edit the spec, request approval, open Decisions: the document and its diff against the last approval are visible; the old approval reads "Superseded by edit"; kill the network for one GET and see Retry.

---

## Wave 2: speed (#4 #19 #26 #27 #28 #13), after wave 1

### Task 2.1: measure (no code merged)
- Record, for the Delivery, Decisions and Tasks tabs after a hard reload: each request, its duration and whether it ran in parallel or in sequence. Keep the snippet in `docs/DEPLOYMENT.md` "Region" so the before/after of task 0.3 is comparable. **Decision gate:** if page load is under 3 s, do only 2.2 and 2.5.

### Task 2.2: one stage-document read instead of three
- **Files:** `apps/cloud/app/db/repository.py` + `supabase_repository.py` (`list_stage_documents(project_id, stages) -> dict[str, StageDocument]`, one query), `apps/cloud/app/delivery/approvals.py` (`stage_hashes` uses it), `apps/cloud/app/api/sync.py` (`_require_delivery_gates` uses `plan_state`), `apps/cloud/tests/test_delivery_round_trips.py`.
- **Acceptance:** `stage_hashes makes one repository call`; round-trip bounds drop (decisions GET ≤ 5, request ≤ 7, resolve ≤ 10); contract test `list_stage_documents` equal on both adapters.

### Task 2.3: one overview call for the delivery surfaces
- **Files:** `apps/cloud/app/api/delivery.py` (`GET /projects/{id}/delivery-overview` → `{plan, decisions, states, roles}`, one membership check, one hash read), `apps/web/src/lib/types.ts`, `DeliveryPlan.tsx`, `DecisionsPanel.tsx`, `ApprovalControl.tsx` (share one `useCloudGet` through a small provider so three components make one request).
- **Acceptance:** `overview answers the same data as the three routes`; `opening Delivery makes one request, not three` (web test counting fetches).

### Task 2.4: pending and stale states (#4, #27, #28)
- **Files:** `NewProjectDialog.tsx` (Create shows "Creating…" and the dialog stays until the redirect), the project page/Delivery board (show "Updating…" while revalidating cached tasks instead of silently painting old titles), `Planner.tsx` (open on the first incomplete step; remember the last step in the URL `?step=`).
- **Acceptance:** `Create shows a pending state until navigation`; `Planner opens on the first incomplete step when steps 0-3 are complete`.

### Task 2.5: deploys stop killing requests (#13 server half)
- **Files:** `apps/cloud/Dockerfile` (`--timeout-graceful-shutdown 30`), `docs/DEPLOYMENT.md` (readiness probe on `/health`, rolling deployment, `terminationGracePeriod` ≥ 35 s), `apps/cloud/app/main.py` if a drain flag is needed.
- **Acceptance:** documented procedure; smoke: start a generation, push, the stream finishes.

---

## Wave 3: VS Code extension reliability (#35 #36 #37 #38 #41 #42 #44 #50a)

All files under `apps/vscode`, `packages/cloud-client`, `apps/mcp`. Pure helpers get unit tests; editor glue is checked by the smoke.

### Task 3.1: signed-out and unlinked are visible (#37, #42)
- **Files:** `apps/vscode/src/extension.ts`, `apps/vscode/src/tasks/treeProvider.ts`, new `apps/vscode/src/auth/status.ts` (pure: `connectionState(session, roster, links) -> "signed_out" | "unlinked" | "ok"` with the message and action).
- **Behavior:** status-bar item "PromptWorkspace: sign in"; a banner node at the top of Projects/My Tasks; one notification per window with **Sign in** / **Link this folder**; cached lists are labelled "last updated … (signed out)".
- **Acceptance:** `connectionState` cases (no session, session but unlinked folder, linked); the existing tree tests extended for the banner node.

### Task 3.2: SSH-alias remotes match (#35)
- **Files:** `packages/cloud-client/src/repoUrl.ts` (+ `test/repoUrl.test.ts`), `docs/contracts/` note.
- **Interface:** `repoUrlKey(remote: string): string | null` unchanged; add `remotesMatch(remote: string, repoUrl: string): "exact" | "alias" | "none"`. `alias` only when hosts differ solely by a `-<suffix>` on the same base host **and** the owner/repo path is identical (`github.com-work` ↔ `github.com`).
- **Acceptance:** `github.com-9haroon:org/repo matches https://github.com/org/repo as alias`; `a different path never matches`; `an alias that matches two roster projects is ambiguous and links neither` (Review Focus).

### Task 3.3: a task click does something useful; Start Task owns the branch (#36, #38)
- **Files:** `apps/vscode/src/tasks/treeProvider.ts` (row click opens a quick pick: Start / Copy context / Open in web), `apps/vscode/src/tasks/startTask.ts` (create **and check out** `T<n>-<slug>`; if the branch exists, check it out), `apps/vscode/src/tasks/copyContext.ts` (header line: "Work on branch `T14-…`; start commit subjects with `T14:`").
- **Acceptance:** `copyContext names the branch and the commit prefix`; `branchNameForTask` cases kept.

### Task 3.4: branch attribution stops at the branch point (#41)
- **Files:** new `apps/vscode/src/git/divergence.ts` (pure: `commitsSinceDivergence(log, baseSha)`), `gitWatcher.ts` (when the head branch carries a ref, only commits after the merge-base with the default branch are attributed by branch; use the Git API `getMergeBase`, fall back to today's behavior if unavailable).
- **Acceptance:** `history already on main is never attributed to a task branch`; `a branch created at HEAD attributes its new commits`.

### Task 3.5: pushes made outside the editor are noticed (#44)
- **Files:** `apps/vscode/src/git/gitBridge.ts` (a `FileSystemWatcher` on `.git/refs/remotes/**` and `.git/FETCH_HEAD` calls `repository.status()`), `gitWatcher.ts`.
- **Acceptance:** smoke: push from a terminal, the task closes within 30 s without a manual fetch.

### Task 3.6: one window refreshes at a time (#50a)
- **Files:** `packages/cloud-client/src/session.ts` + `client.ts` (a lease `{owner, until}` in the shared state; a window refreshes only if it holds or can take an expired lease; others re-read the secrets), injected clock for tests.
- **Acceptance:** `two clients over one store make one refresh call`; `an expired lease is taken over` (Review Focus); the cross-window rotation tests keep passing.

**Wave 3 smoke:** two Cursor windows open, sign in once, wait for token expiry (shorten with a test config), tasks still load in both; commit with `T14:`, push from a terminal, task closes.

---

## Wave 4: generation quality and data integrity (#5 #6 #7 #8 #15 #16 #31 #33 #54 #56 #57)

All under `apps/cloud/app/generation`, `app/imports`, `app/integrations/repo_seed.py`.

### Task 4.1: regeneration must not carry closed work onto different tasks (#57) — first, it is data integrity
- **Files:** `apps/cloud/app/generation/stage_apply.py` (`_apply_tasks`), `apps/cloud/tests/test_stage_regeneration.py`.
- **Rule:** when an existing live task is `implemented`/`verified` (or has an artifact) and the regenerated task with the same ref has a materially different title (normalized-token similarity below 0.6), retire the old row (status, assignee and artifacts stay on it as history) and insert a fresh `todo` row under the ref. Same or lightly reworded titles keep today's behavior (same id, status, assignee).
- **Interface:** `titles_match(old: str, new: str) -> bool` in `app/generation/parsing.py`, pure.
- **Acceptance:** `a closed task whose ref now means different work is retired with its evidence`; `a reworded title keeps its status`; `titles_match` table (Thai included).

### Task 4.2: where do the strings live? (#54) — timeboxed spike, then build
- **Spike (half a day, opus):** choose how `tasks` learns which files contain the strings the spec renames (`ASSET GROW`, `assetgrow`): (a) GitHub code search at generation time for up to 5 quoted strings from the spec (indexing lag on new repos, rate limit), or (b) widen the snapshot fetch and grep what was fetched. Write the decision at the top of this task with the measured recall on `marketing-studio-check`.
- **Build:** `[repo_occurrences]` segment (file → count per token, capped) injected for `tasks` on imported projects; the checker is unchanged.
- **Acceptance:** `the segment lists the files that contain a quoted spec string`; live: regenerated tasks name `src/App.tsx` and `src/lib/exporters.ts` for the rebrand.

### Task 4.3: prompt-quality batch (#5, #7, #8, #15, #16, #33, #56) — prompts only, one commit
- **Files:** `app/generation/prompts.py`, `app/generation/prefill.py`, `app/generation/templates/codebase-baseline-template.md`, `app/imports/snapshot.py` (list `.env.example` family names).
- **Changes:**
  - baseline: each "Implemented" claim cites the file it rests on, `(src/lib/store.tsx)`; storage claims name the mechanism (#5, #7);
  - plan: author-supplied plan fields override the spec/baseline; where they disagree, say so in the plan (#16);
  - constitution: no principle is marked non-negotiable or mandatory unless the author's rules say so (#15);
  - prefill: only from the PRD, and every stated goal appears in the journeys (#8);
  - brownfield tasks: when the baseline reports no CI or tests, the first task is "confirm install, lint and build pass and record the result" (#33);
  - `.env.example`, `.env.sample`, `.env.template` appear in the file list as names (#56).
- **Acceptance:** one `in prompt` assertion per rule plus `test_env_template_names_are_listed_without_contents`; live: regenerate the check project's constitution and spec and read them.

### Task 4.4: seeded docs lose the Spec Kit boilerplate (#31)
- **Files:** `apps/cloud/app/integrations/repo_seed.py` (`build_seed_files` drops the `Input:`, `Prerequisites:`, `Tests: ... OPTIONAL` header lines from `docs/tasks.md` and rewrites `/specs/...` references).
- **Acceptance:** `the seeded tasks.md has no Spec Kit header boilerplate`.

### Task 4.5: say which files the analysis skipped (#6)
- **Files:** `app/imports/snapshot.py` (`skipped: list[{path, reason}]`, capped), `schemas.py`, `apps/web/src/components/project/CodebaseAnalysisPanel.tsx`, `types.ts`.
- **Acceptance:** `52 of 53 files read lists the skipped file and why`.

**Wave 4 smoke:** on `marketing-studio-check`, regenerate tasks; no warnings, rebrand tasks name the right files; on the main project, regenerate in a copy of the data (not in place) only after 4.1 is merged.

---

## Wave 5: the delivery view, small UI, picker (#2 #14 #51 #55), after wave 2

### Task 5.1: progress per Change (#51)
- **Files:** `apps/cloud/app/db/repository.py` + `supabase_repository.py` (`list_task_change_status(project_id) -> list[tuple[task_id, change_id, status]]`, replaces `list_task_change_ids` at its call sites), `apps/cloud/app/api/delivery.py` (`DeliveryChangeOut.done`, `.total`), `types.ts`, `DeliveryPlan.tsx` (each card: "2/3 done" bar), `ProgressRollup.tsx` (group by Change).
- **Acceptance:** `delivery-plan reports done and total per change`; `a closed task moves its Change's counter`; round-trip bound unchanged.

### Task 5.2: the picker marks repos that are already imported (#55)
- **Files:** `apps/cloud/app/api/github.py` (the repos listing adds `imported_by: {project_id, name} | null`, resolved with one lookup per repo), `GithubRepo` type, `NewProjectDialog.tsx` (disabled row "Already imported as <name>").
- **Acceptance:** `an imported repo is listed with imported_by`; `its row is disabled`.

### Task 5.3: small UI polish (#2, #14)
- **Files:** `apps/web/src/components/TopBar.tsx` (truncate the switcher label to one line with a title), the Planner rules form (the optional fields' default text becomes a placeholder, not a value).
- **Acceptance:** `a long workspace name does not wrap`; `typing in an optional rules field does not append to default text`.

---

## Findings map

| # | Where | # | Where | # | Where |
|---|---|---|---|---|---|
| 1 | done | 21 | done | 41 | 3.4 |
| 2 | 5.3 | 22 | done | 42 | 3.1 |
| 3 | 0.1 | 23 | deferred | 43 | done |
| 4 | 2.4 | 24 | 0.1 | 44 | 3.5 |
| 5 | 4.3 | 25 | 1.4 | 45 | done |
| 6 | 4.5 | 26 | 0.3, 2.x | 46 | done |
| 7 | 4.3 | 27 | 2.4 | 47 | pass |
| 8 | 4.3 | 28 | 2.4 | 48 | done |
| 9 | 1.5 | 29 | done | 49 | done |
| 10 | 1.4 | 30 | pass | 50 | 3.6 (a); b-d deferred |
| 11 | 1.1 | 31 | 4.4 | 51 | 5.1 |
| 12 | 1.2 | 32 | deferred | 52 | pass |
| 13 | 1.4, 2.5 | 33 | 4.3 | 53 | pass |
| 14 | 5.3 | 34 | pass | 54 | 4.2 |
| 15 | 4.3 | 35 | 3.2 | 55 | 5.2 |
| 16 | 4.3 | 36 | 3.3 | 56 | 4.3 |
| 17 | 1.5 | 37 | 3.1 | 57 | 4.1 |
| 18 | 1.3 | 38 | 3.3 | | |
| 19 | 0.3, 2.x | 39 | done | | |
| 20 | done, 0.2 | 40 | done | | |

## Self-review

- **Coverage:** every finding #1–#57 appears in the triage or the map above.
- **No placeholders in what is committed to:** each task names real files (checked to exist), interfaces and named acceptance tests. Step-by-step TDD with code is deliberately produced per wave at wave start; the one unresolved design choice (4.2) is an explicit, timeboxed spike with a decision gate, not a hidden TBD.
- **Consistency:** `Decision.subject_content` (1.1), `is_current` (1.3) and `list_task_change_status` (5.1) are each defined once and used only after their defining task; waves 2 and 5 depend on 1 for `delivery.py`/`DecisionsPanel.tsx`.
