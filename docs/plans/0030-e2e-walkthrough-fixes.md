# 0030 — Fixes from the 2026-10-17 end-to-end walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Draft, 2026-10-17. Branch `fix/e2e-walkthrough-0030`, cut from `feature/trust-outcome` (the decision code these fixes touch exists only there).

**Goal:** Fix the gaps a three-role walkthrough (BA, Tech Lead, Developer in Cursor with Claude Code) found on the trust environment, so one task can travel from intent to Verified without workarounds.

**Architecture:** Four milestones, each shippable alone. M1 makes generated documents complete and free of Spec Kit scaffolding (cloud only). M2 makes decisions mean something: plan generation waits for an approved intent, plan approval covers the plan and rules, the requester hears back, the reviewer sees what changed. M3 is web polish. M4 is the editor: a developer can link a project before its repository exists, is told to hand the task to an agent, and gets a context that does not send the agent hunting for files.

**Tech Stack:** FastAPI + pytest (`apps/cloud`), Next.js 16 + React 19 + vitest (`apps/web`), VS Code extension on `node --test` (`apps/vscode`), shared `packages/cloud-client`.

**Spec:** Findings file `promptconnext-projects/local/2026-10-17-e2e-walkthrough-findings.md` (umbrella repo, gitignored). Finding numbers below (F1–F28) refer to it.

## Global Constraints

- Every change lands with a test that fails first, except where a task says the code has no test harness (files that import `vscode` at runtime); those get a manual check step.
- Cloud: `ruff check .` clean, line length 100. Tests stay hermetic (`DATA_BACKEND=memory`).
- Web: `tsc --noEmit` and `vitest run` green.
- Extension: no `typeof vscode.` feature detection (`scripts/check-feature-detection.mjs`); no sidecar (ADR 0019); settings only through `promptworkspace.*`.
- `packages/cloud-client/src/taskRefs.ts` is vendored byte-for-byte into `apps/engine/src/git/taskRefs.ts`; any edit re-vendors the copy and `apps/engine/test/task-refs.test.ts` must pass.
- The task-ref grammar (`docs/contracts/task-ref-grammar.md`, `task-ref-cases.json`) is not changed by this plan.
- Copy is plain English, sentence case, no exclamation marks. Dates absolute.
- No new migration unless a task says so. None does.
- The legacy engine (`apps/engine`, retired by ADR 0019) is not fixed, except the re-vendored `taskRefs.ts`.

## Decisions this plan takes (confirm before M2)

1. **Intent gate (F1).** Plan generation is refused while the project's latest intent decision is open or has changes requested. A project that never requested intent approval is not gated, so teams that do not use approvals are unaffected. Tasks generation is not gated by plan approval (plan approval is requested after tasks exist). Repository creation keeps its existing `require_plan_approval` flag.
2. **Plan approval subject (F2).** The plan approval covers three documents in this order: project rules (constitution), plan, tasks. One snapshot, one hash; editing any of the three makes the approval stale. This closes plan 0029 §13 item 14.
3. **Unassigned roles (F3).** Keep the admin fallback. The request control warns when the role is unassigned and links to project settings; it does not block.
4. **Task ID spelling (F26).** Out of scope here. The grammar treats `T1` and `T001` as one reference; changing what `startTask` writes needs a contract update. Listed under Deferred.

## Review Focus

1. A generated document containing several nested code fences (plan with a `text` tree and a `bash` block) must come back whole, not just up to the first inner fence. Task 1 pins it.
2. A user who presses Escape at the Start Task git picker must not end up holding the task. Task 18 pins it by asking before claiming.
3. A plan approval requested before this change (subject = tasks only) must still resolve and still compute staleness without raising. Task 6 pins it.
4. A member opening Settings, Inbox or the Planner must not see admin-only copy flash before roles load. Task 12 pins it.
5. A project linked by hand to a repo-less project must still list its tasks, and a project that later gets a repository must still auto-link by remote. Task 17 pins both.

---

## M1 — Complete, clean generated documents (cloud)

### Task 1: Keep everything inside the `file:` block when the document has inner fences (F4)

Root cause of the "truncated" plan and tasks: `_FILE_BLOCK_RE` is non-greedy and stops at the first inner ```` ``` ````. The plan template opens a ```` ```text ```` fence under "Documentation (this feature)"; the tasks template a ```` ```bash ```` fence under "Parallel Example".

**Files:**
- Modify: `apps/cloud/app/generation/parsing.py:14,23-30` (`_FILE_BLOCK_RE`, `parse_files`)
- Test: `apps/cloud/tests/test_generation_parsing.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_parse_files_keeps_inner_fences():
    raw = "```file:plan.md\n# Plan\n\n### Documentation\n\n```text\nspecs/\n```\n\n## After\nmore\n```\n"
    files = parse_files(raw)
    assert len(files) == 1
    assert files[0]["content"].endswith("## After\nmore\n")
    assert "```text\nspecs/\n```" in files[0]["content"]

def test_parse_files_two_blocks_each_with_inner_fence():
    raw = ("```file:a.md\n# A\n```bash\nls\n```\nend A\n```\n"
           "```file:b.md\n# B\n```text\nx\n```\nend B\n```\n")
    files = parse_files(raw)
    assert [f["path"] for f in files] == ["a.md", "b.md"]
    assert files[0]["content"].endswith("end A\n") and files[1]["content"].endswith("end B\n")
```

- [ ] **Step 2:** Run `cd apps/cloud && pytest tests/test_generation_parsing.py -q -k inner_fence`. Expected: FAIL (content ends at `### Documentation\n\n`).
- [ ] **Step 3: Implement** `parse_files(raw: str) -> list[dict[str, str]]` as a line scanner instead of one regex: a line starting with ```` ```file: ```` opens a block; inside a block, a line that is exactly ```` ``` ```` closes an inner fence if one is open (a line matching ```` ```<lang> ```` opened it), otherwise closes the block. Keep the `..` / leading `/` path guard. Delete `_FILE_BLOCK_RE` if nothing else uses it (`grep -n _FILE_BLOCK_RE`).
- [ ] **Step 4:** Run `pytest tests/test_generation_parsing.py tests/test_generation.py -q`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud): keep inner code fences inside generated file blocks`.

### Task 2: Strip Spec Kit scaffolding from generated documents at generation time (F5)

**Files:**
- Modify: `apps/cloud/app/generation/parsing.py` (`strip_template_scaffolding`, `fix_template_placeholders`), `apps/cloud/app/integrations/repo_seed.py:108-126` (move `_HEADER_BOILERPLATE_RE` and `_SPECS_REF_RE` into `parsing.py` and import them back)
- Modify: `apps/cloud/app/generation/templates/spec-template.md:3,94-99`, `plan-template.md:5,44-60`, `tasks-template.md:8-12,159`, `tasks-template-existing.md:8-12`, `constitution-template.md:47`
- Test: `apps/cloud/tests/test_generation_parsing.py`, `apps/cloud/tests/test_repo_seed.py` (must stay green)

**Interfaces:**
- Produces: `strip_spec_kit_boilerplate(content: str) -> str` in `parsing.py`, called inside the existing post-processing line `service.py:159` (`fix_template_placeholders(strip_template_scaffolding(content))` becomes `strip_spec_kit_boilerplate(fix_template_placeholders(strip_template_scaffolding(content)))`).

- [ ] **Step 1: Write the failing test** `test_strip_spec_kit_boilerplate_removes_scaffolding` with one input holding each leaked string from the walkthrough and these assertions on the output:
  - no line starting `**Feature Branch**:`
  - no `Example of marking unclear requirements` and no FR line that follows it inside that example block
  - no `[GUIDANCE_FILE]`
  - no `**Input**:` / `**Prerequisites**:` header lines and no `Tests are OPTIONAL`
  - no `/specs/` path
  - text inside a fenced block is left alone (assert a fenced `/specs/x` survives)
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement** `strip_spec_kit_boilerplate` with `_sub_outside_fences` (`parsing.py:93`). Rules: drop the `**Feature Branch**` line; drop the "Example of marking unclear requirements" line and the contiguous list items under it; drop any line containing `[GUIDANCE_FILE]`; apply the moved `_HEADER_BOILERPLATE_RE`; replace `_SPECS_REF_RE` matches with the bare document name (`spec.md` → "the specification", `plan.md` → "the plan", `tasks.md` → "the task list"). In the templates, delete the example block, the Feature Branch line, the "Documentation (this feature)" tree (research.md, data-model.md, quickstart.md, contracts/), the `quickstart.md validation` task and the "Tests are OPTIONAL" line, so the model is not shown them in the first place.
- [ ] **Step 4:** Run `pytest tests/test_generation_parsing.py tests/test_repo_seed.py tests/test_generation_prompts.py -q`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud): strip Spec Kit scaffolding from generated documents`.

### Task 3: Stop the spec stage inventing channels, vendors and features (F6)

**Files:**
- Modify: `apps/cloud/app/generation/prompts.py` (new `SPECIFY_SCOPE_RULE`, appended for `stage == "specify"` in `driver_prompt`, next to how `CONSTITUTION_STRENGTH_RULE` is appended)
- Test: `apps/cloud/tests/test_generation_prompts.py`

- [ ] **Step 1: Write the failing test** `test_specify_prompt_forbids_unrequested_channels`: `driver_prompt("specify", …)` contains `SPECIFY_SCOPE_RULE`; `driver_prompt("plan", …)` does not.
- [ ] **Step 2:** Run it. Expected: FAIL (name not defined).
- [ ] **Step 3: Implement.** Exact rule text:
  `"Do not add channels, vendors, integrations, devices or features the author's answers do not name. Where a journey needs one the author did not name, write [NEEDS CLARIFICATION: which <thing>?] instead of choosing."`
- [ ] **Step 4:** Run `pytest tests/test_generation_prompts.py -q`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud): spec prompt marks unnamed channels as clarifications`.

### Task 4: Accept common task-line variants and report gaps in numbering (F22)

**Files:**
- Modify: `apps/cloud/app/generation/parsing.py:16,148-171` (`_TASK_LINE_RE`, `parse_task_lines`), `apps/cloud/app/api/generation.py:~360` (tasks branch of the `done` payload)
- Test: `apps/cloud/tests/test_generation_parsing.py`, `apps/cloud/tests/test_generation.py`

**Interfaces:**
- Produces: `missing_task_refs(refs: list[str]) -> list[str]` in `parsing.py` (returns the gaps between the lowest and highest numeric ref, formatted as the tasks' own padding, e.g. `["T029"]`). The tasks `done` payload gains `warnings` item `{"code": "missing_task_numbers", "items": [...]}` when non-empty, appended to the existing `warnings` list.

- [ ] **Step 1: Write the failing tests**
  - `test_parse_task_lines_accepts_variants`: each of `- [ ]  T029 x` (two spaces), `- [ ] **T029** x`, `- [ ] T029: x`, `* [x] T029 [P] [US3] x` parses to ref `T029`.
  - `test_missing_task_refs`: `missing_task_refs(["T001","T002","T004"]) == ["T003"]`; `missing_task_refs([]) == []`.
  - In `test_generation.py`, `test_tasks_done_payload_warns_on_missing_numbers`: a fake tasks document with T001, T002, T004 yields `warnings` containing code `missing_task_numbers` with items `["T003"]`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Widen `_TASK_LINE_RE` to `^\s*[-*]\s+\[[ xX]?\]\s+\**(T\d+)\**:?\s+(\[P\]\s+)?(.+)$`. Keep the AC regex. Phase grouping (`parsing.py:250`) reuses the regex unchanged.
- [ ] **Step 4:** Run `pytest tests/test_generation_parsing.py tests/test_generation.py tests/test_task_phases.py tests/test_stage_regeneration.py -q`. Expected: PASS.
- [ ] **Step 5:** Web: in `apps/web/src/components/project/Planner.tsx` where `unmatched_new_paths` warnings render, render `missing_task_numbers` as "Task numbers missing from the generated list: T029. Regenerate, or add them by hand." Test in `Planner.test.tsx` (`renders missing task numbers warning`). Run `pnpm --dir apps/web exec vitest run src/components/project/Planner.test.tsx`.
- [ ] **Step 6:** Commit `fix(cloud,web): parse task-line variants and warn on missing task numbers`.

### Task 5: Prefill fills select fields and keeps one-line fields on one line (F15)

**Files:**
- Modify: `apps/cloud/app/api/generation.py:400-403` (`PrefillField` gains `options: list[str] = Field(default_factory=list, max_length=24)`), `apps/cloud/app/generation/prefill.py:46-77` (`build_prompt` lists `options: a | b | c` for fields that have them; `parse_prefill` maps a value to the option it equals case-insensitively, else drops it)
- Modify: `apps/web/src/components/project/StageInputForm.tsx:323-362` (send `options` for select fields; when merging into a single-line text field, join lines with `"; "`), `apps/web/src/components/project/stage-forms.ts:191-206` (add a hint to `project_type`)
- Test: `apps/cloud/tests/test_prefill.py`, `apps/web/src/components/project/StageInputForm.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - cloud `test_prefill_select_value_must_be_an_option`: field `project_type` with options `["Web application","CLI tool"]`; model returns `"web application"` → `"Web application"`; returns `"Website"` → key absent.
  - cloud `test_prefill_prompt_lists_options`: `build_prompt` output contains `Web application | CLI tool`.
  - web `drafts a select field from its options and flattens multi-line answers for inputs`: mocked prefill response `{project_type: "Web application", testing: "Jest\nPlaywright"}` → select shows "Web application", testing input value is `"Jest; Playwright"`, and the request body's `project_type` field carries `options`.
- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3: Implement** as described in Files.
- [ ] **Step 4:** Run `pytest tests/test_prefill.py -q` and `pnpm --dir apps/web exec vitest run src/components/project/StageInputForm.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud,web): prefill selects from options and keeps inputs single-line`.

---

## M2 — Decisions that mean something

### Task 6: Plan approval covers project rules, plan and tasks (F2, plan 0029 §13 item 14)

**Files:**
- Modify: `apps/cloud/app/delivery/decisions.py:23` (`STAGE_OF` → `SUBJECT_STAGES: dict[str, tuple[str, ...]] = {"intent_approval": ("specify",), "plan_approval": ("constitution", "plan", "tasks")}`; keep `STAGE_OF` as the last stage of each tuple for code that needs one stage)
- Modify: `apps/cloud/app/delivery/approvals.py:35-80` (`current_hash`, `stage_hashes`, `plan_state`), `apps/cloud/app/api/delivery.py:436-510` (`request_decision`), `:315` (`decision_out.is_current`), `:~546` (`resolve_decision` subject-changed check)
- Test: `apps/cloud/tests/test_decisions_api.py`, `apps/cloud/tests/test_decision_rules.py`

**Interfaces:**
- Produces: `approval_subject(repo: Repository, project_id: str, kind: str) -> str | None` in `approvals.py`: joins the present documents, each trimmed, as `"===== Project rules =====\n\n{constitution}\n\n===== Plan =====\n\n{plan}\n\n===== Tasks =====\n\n{tasks}"`, leaving out an absent or blank rules or plan document with its separator (intent: the specify document unchanged); returns `None` when the kind's last stage is missing. `current_hash(repo, project_id, kind)` hashes `approval_subject`. Every caller that passed a stage now passes a kind.

- [ ] **Step 1: Write the failing tests**
  - `test_plan_approval_snapshot_includes_rules_plan_and_tasks`: request plan approval; the stored `subject_content` contains `===== Project rules =====`, `===== Plan =====`, `===== Tasks =====` and each document's text.
  - `test_editing_plan_stales_plan_approval`: approve, then save a changed plan document → plan approval state is `stale`.
  - `test_legacy_tasks_only_plan_approval_reads_stale_and_409s`: insert a plan decision whose `subject_content` is tasks text only (pre-change shape); resolving it returns 409 `decision_subject_changed` rather than 500, and the approval state reads `stale`.
- [ ] **Step 2:** Run `pytest tests/test_decisions_api.py tests/test_decision_rules.py -q -k "rules_plan_and_tasks or stales_plan or legacy_tasks_only"`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. The repository-creation gate (`sync.py:776-782`) uses the same `current_hash`.
- [ ] **Step 4:** Run `pytest tests/test_decisions_api.py tests/test_decision_rules.py tests/test_delivery_gate.py -q`. Expected: PASS.
- [ ] **Step 5:** Web: `DecisionSubject` already shows the content; no code change. In plan 0029 §13 mark item 14 "Done in plan 0030 Task 6".
- [ ] **Step 6:** Commit `feat(cloud): plan approval covers project rules, plan and tasks`.

### Task 7: Plan generation waits for an approved intent once approval is in use (F1)

**Files:**
- Modify: `apps/cloud/app/api/generation.py:95-126` (`generate`, before streaming, `stage == "plan"`)
- Modify: `apps/web/src/components/project/Planner.tsx:1220-1241` (Continue to Plan) and the Plan `StageSection` disabled logic (`:416/:427`)
- Test: `apps/cloud/tests/test_generation.py`, `apps/web/src/components/project/Planner.test.tsx`

**Interfaces:**
- Consumes: `latest_decision(decisions, "intent_approval")` and `approval_state(...)` from `decisions.py`.
- Produces: HTTP 409 `{"detail": "intent_not_approved"}` from `POST /projects/{id}/generate/plan` when the latest intent decision exists and its state is `requested` or `changes_requested`.

- [ ] **Step 1: Write the failing tests**
  - cloud `test_plan_generation_refused_while_intent_open` (409 `intent_not_approved`), `test_plan_generation_allowed_when_intent_never_requested` (200), `test_plan_generation_allowed_after_intent_approved` (200).
  - web `blocks Continue to Plan while intent waits for approval`: approval state `requested` → no "Continue to Plan" button, and the Plan section shows "Waiting for the intent to be approved. The plan is written once the business owner approves it." Same for `changes_requested` with "Changes were requested on the intent. Revise the specification and ask again."
- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3: Implement.** Web maps `intent_not_approved` in the generation error mapper to the same copy. Specify stays "completed" in the stepper only when the intent is approved or never requested (`tabDone` at `Planner.tsx:892-908`).
- [ ] **Step 4:** Run `pytest tests/test_generation.py -q` and `pnpm --dir apps/web exec vitest run src/components/project/Planner.test.tsx`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud,web): plan generation waits for an approved intent`.

### Task 8: The requester sees decisions sent back to them (F11)

**Files:**
- Modify: `apps/cloud/app/api/me.py:55-100` (`list_my_decisions` gains query param `include_mine: bool = False`; when true, also returns the caller's own decisions whose status is `changes_requested` and that are still the latest of their kind), `apps/cloud/app/delivery/notices.py` (new `changes_requested(decision, project_name, link) -> tuple[str, str]`), `apps/cloud/app/api/delivery.py` (`resolve_decision` sends it to the requester when the outcome is changes requested, via the same mail path `request_decision` uses at `:502-506`)
- Modify: `apps/web/src/app/w/[workspaceId]/inbox/page.tsx` (second section "Sent back to you", from `/me/decisions?workspace_id=…&include_mine=true`, rows show the reason), `apps/web/src/components/project/ApprovalControl.tsx` (when state is `changes_requested`, show the resolver's reason under the pill)
- Test: `apps/cloud/tests/test_me.py` (or the existing `/me` test file), `apps/cloud/tests/test_decision_notices.py` (or the notices test file), `apps/web/src/app/w/[workspaceId]/inbox/page.test.tsx`, `apps/web/src/components/project/ApprovalControl.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - `test_me_decisions_include_mine_returns_changes_requested`: requester sees their sent-back decision only with `include_mine=true`; a later re-request of the same kind hides it.
  - `test_changes_requested_notice`: subject `"Changes requested: <kind label> for <project>"`, body contains the reason and the link.
  - `test_resolve_changes_requested_emails_requester` with the fake mailer.
  - web inbox: renders "Sent back to you" with the reason; web ApprovalControl: shows the reason text under "Changes requested".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** as in Files.
- [ ] **Step 4:** Run the four test files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud,web): tell the requester when changes are requested`.

### Task 9: Re-review shows what changed since the version that was sent back (F12)

**Files:**
- Modify: `apps/cloud/app/api/delivery.py:278-291` (`content_carriers` also carries the newest `changes_requested` decision per kind), `apps/web/src/components/project/DecisionsPanel.tsx:35-46` (`previousApproved` → `diffBase(decisions, decision): {decision, label} | null`: newest earlier approved of the kind, else newest earlier changes-requested), `apps/web/src/components/project/DecisionSubject.tsx:49-52` (caption from `label`: "Changes since the approved version" or "Changes since the version sent back")
- Test: `apps/cloud/tests/test_decisions_api.py`, `apps/web/src/components/project/DecisionSubject.test.tsx`, `DecisionsPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**: cloud `test_content_carriers_include_latest_changes_requested`; web `diffs a re-request against the version sent back` (caption text above, added/removed lines marked).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): diff a re-requested decision against the version sent back`.

### Task 10: Request controls say who approves and show progress (F3, F21, F14)

**Files:**
- Modify: `apps/web/src/components/project/ApprovalControl.tsx` (pending label "Requesting…"; when the kind's hat is unassigned, a line "No <Business owner|Tech steward> is set, so any other workspace admin can approve. Set roles" linking to `/w/{ws}/p/{project}/settings`), `apps/web/src/components/project/DecisionsPanel.tsx:110-117` (own-request copy), `apps/web/src/components/project/Planner.tsx` (Plan step footer note)
- Test: `ApprovalControl.test.tsx`, `DecisionsPanel.test.tsx`, `Planner.test.tsx`

**Interfaces:**
- Consumes: project roles from the same source `ProjectRolesPanel` reads (`/projects/{id}/roles` or the field it uses; reuse its fetch hook).

- [ ] **Step 1: Write the failing tests**
  - `shows Requesting… while the request is in flight`
  - `warns when the approving role is unassigned`
  - own-request copy is now "You requested this, so someone else must approve it: the <hat label>, or another workspace admin if none is set." (exact string, with the hat label substituted)
  - Plan step shows "Plan approval is requested on the Tasks step, once tasks are generated. It covers the project rules, the plan and the tasks."
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the three files. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): approval controls name the approver and show progress`.

### Task 11: Verifying a task shows its evidence and asks to confirm (F10)

**Files:**
- Modify: `apps/web/src/components/project/TaskDrawer.tsx:112-139` (`ArtifactRow`: when the project has `repo_url` and the artifact is a commit, link to `{repo_url without .git}/commit/{sha}`), `apps/web/src/components/project/TaskBoard.tsx:292-330` (`move()`: moving to `verified` opens a confirm dialog listing the task's acceptance criteria and artifacts, buttons "Mark verified" / "Cancel"), the drawer's caller passes `repoUrl`
- Test: `TaskDrawer.test.tsx`, `TaskBoard.test.tsx`

- [ ] **Step 1: Write the failing tests**: `links a commit artifact to the repository`; `asks to confirm before moving to Verified` (cancel leaves the card in Implemented; confirm writes `verified`); a task with no artifacts shows "No commit is linked to this task yet." in the dialog.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** Server audit of verification is deferred (D3); no API change.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): confirm Verified with the task's evidence`.

---

## M3 — Web polish

### Task 12: No admin-only copy before roles load (F13, F28)

**Files:**
- Modify: `apps/web/src/components/project/Planner.tsx:1063-1067,1132-1215` (panels render the existing skeleton until members load; on `membersError` show "Could not load your role. Reload to try again." instead of treating the user as a member), `apps/web/src/components/project/ProjectRolesPanel.tsx:65-98` (members see "Only workspace admins can change these roles.")
- Test: `Planner.test.tsx`, `ProjectRolesPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**: `does not show the Tech Lead note while members load` (pending members fetch → no `TECH_LEAD_NOTE` text); `explains disabled role pickers to members`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** The request waterfall (graph → stage documents) is out of scope; see Deferred.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `fix(web): wait for roles before rendering role-gated copy`.

### Task 13: Presence shows people, not ids (F23)

**Files:**
- Modify: `apps/web/src/components/PresenceBar.tsx:13-20` (takes `members`; chip text = initial of the member's email or name, `title` = name or email; unknown id falls back to "?" and title "Someone in this workspace"), its caller on the project page passes the members it already loads
- Create: `apps/web/src/components/PresenceBar.test.tsx`

- [ ] **Step 1: Write the failing test** `shows member initials and emails, never raw ids`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `fix(web): presence chips show members, not user ids`.

### Task 14: Members land on their tasks; Inbox shows a count (F24)

**Files:**
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx:47-48` (`tabFromParam`: with no `tab` param, a non-admin whose user id is assigned at least one task in the graph opens `tasks`), `apps/web/src/app/w/[workspaceId]/page.tsx:106-111` (Inbox button shows `Inbox · N` from `/me/decisions?workspace_id=…` when N > 0)
- Test: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.test.tsx` (or the existing page test), `apps/web/src/app/w/[workspaceId]/page.test.tsx`

- [ ] **Step 1: Write the failing tests**: `opens Tasks for a member with assigned tasks`; `opens Planner for an admin`; `shows the number of decisions waiting`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): members open on their tasks; Inbox shows a count`.

### Task 15: Recommend the deployment template the plan fits (F16)

**Files:**
- Modify: `apps/cloud/app/api/deployments.py:224-268` (each template in the list response gains `recommended: bool`), `apps/web/src/components/project/DeploymentTemplatePanel.tsx:159-192` (recommended template first, badge "Fits your plan")
- Test: `apps/cloud/tests/test_deployment_templates.py`, `DeploymentTemplatePanel.test.tsx`

**Interfaces:**
- Produces: `recommend_template(plan_text: str | None) -> str | None` in `apps/cloud/app/deployments/plan_profile.py`: uses `derive_stack_profile`; returns `"docker-compose"` when the profile has any service or a non-static runtime named in the plan, `"next-vercel"` when the plan names Next.js, `"static-r2"` when the plan names a static site and no server runtime, else `None`. Use the template ids exactly as in `registry.py`.

- [ ] **Step 1: Write the failing tests**: `recommend_template` for an Express + PostgreSQL plan → `"docker-compose"`; Next.js plan → `"next-vercel"`; plain HTML plan → `"static-r2"`; empty → `None`. API test: exactly one template has `recommended: true` for the Express plan. Web: recommended card renders first with the badge.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud,web): recommend the deployment template the plan fits`.

---

## M4 — The developer's editor

### Task 16: Build and install the current extension, then re-check the stale-build findings

The installed Cursor/VS Code build is a hand-patched staging VSIX from 2026-10-04. Current source already has the task actions menu, the cross-window `secrets.onDidChange` listener and a signed-out state.

**Files:** none changed.

- [ ] **Step 1:** `pnpm --dir apps/vscode build && pnpm --dir apps/vscode package`. Expected: a `.vsix` in `apps/vscode`.
- [ ] **Step 2:** `cursor --install-extension apps/vscode/<file>.vsix --force`, reload `~/pw-e2e-clinic-booking` (its `.vscode/settings.json` points at trust).
- [ ] **Step 3:** Re-run walkthrough steps 2–5 and record in the findings file whether F9 (silent session loss) and F25 (repo-less icon tooltip) still reproduce. A finding that no longer reproduces is closed here; one that does gets its own task appended to this milestone.

### Task 17: Link a folder to a project that has no repository yet (F7)

**Files:**
- Modify: `apps/vscode/src/projects/roster.ts:202-219` (new `pickerCandidatesFrom(rows): ProjectCandidate[]` that includes repo-less projects with `repoUrl: null`; `linkCandidatesFrom` stays repo-only for auto-matching), `apps/vscode/src/extension.ts:227,590-592` (`linkInteractively` gets `pickerCandidatesFrom`), `apps/vscode/src/link/projectLink.ts:137-147,204-218` (empty-list message "No PromptWorkspace projects to link to."; repo-less items get `detail: "No repository yet. Tasks work; closing on push starts once the repository exists."`)
- Test: `apps/vscode/test/unit/roster.test.ts`

- [ ] **Step 1: Write the failing tests**: `picker candidates include projects without a repository`; existing `link candidates carry every project with a usable repo` still passes unchanged (auto-match stays repo-only).
- [ ] **Step 2:** `pnpm --dir apps/vscode test`. Expected: FAIL on the new test.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `pnpm --dir apps/vscode test && pnpm --dir apps/vscode typecheck`. Expected: PASS.
- [ ] **Step 5: Manual check:** remove `promptworkspace.projectId` from the test folder, run Link This Folder; the E2E project is listed with the no-repository detail; after linking, MY TASKS lists T001 and T002.
- [ ] **Step 6:** Commit `feat(vscode): link a folder to a project before its repository exists`.

### Task 18: Start Task asks first, then claims, then says what to do next (F8, F19)

**Files:**
- Modify: `apps/vscode/src/tasks/startTask.ts:36-92,134-158` (`askGitChoice` returns `GitChoice | undefined`; `startTask` calls it before `claim()` and returns on `undefined`; after success shows the next-step notification), `apps/vscode/src/extension.ts:511-527` (wire the notification's actions to `promptworkspace.copyTaskContext` and `promptworkspace.openTaskInWeb` for that task)
- No unit test harness for this file (imports `vscode`); manual check below.

**Interfaces:**
- Produces: notification text `"Started <feature_tag> on branch <branch>. Next, hand it to your AI agent: copy the task context and paste it into Claude Code, Cursor or your agent of choice."` (for "Prefill" and "Neither" choices, replace `on branch <branch>` with `on <current branch>`), actions `"Copy Task Context"`, `"Open in Web"`.

- [ ] **Step 1: Implement** the reorder and the notification.
- [ ] **Step 2:** `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`. Expected: PASS.
- [ ] **Step 3: Manual check** with the rebuilt VSIX: Escape at the picker leaves T002 in To Do on the web board; choosing "Create branch" shows the notification; "Copy Task Context" puts the context on the clipboard.
- [ ] **Step 4:** Commit `feat(vscode): Start Task asks before claiming and points to the agent hand-off`.

### Task 19: Branch names stop at a word boundary (F26, branch part only)

**Files:**
- Modify: `packages/cloud-client/src/taskRefs.ts:127-135` (`branchNameForTask`: after slugging, if longer than `SLUG_MAX`, cut at the last `-` at or before `SLUG_MAX`; a single word longer than `SLUG_MAX` is still hard-cut)
- Re-vendor: `apps/engine/src/git/taskRefs.ts` (byte-for-byte copy)
- Test: `packages/cloud-client/test/taskRefs.test.ts:173-188`

- [ ] **Step 1: Write the failing test**: `branchNameForTask("T1", "Create project structure per implementation plan") === "T1-create-project-structure-per"`; a 60-letter single word is cut to 40.
- [ ] **Step 2:** `pnpm --dir packages/cloud-client test`. Expected: FAIL.
- [ ] **Step 3: Implement**, then `cp packages/cloud-client/src/taskRefs.ts apps/engine/src/git/taskRefs.ts`.
- [ ] **Step 4:** `pnpm --dir packages/cloud-client test && (cd apps/engine && node --test test/task-refs.test.ts)`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud-client): cut task branch slugs at a word boundary`.

### Task 20: Task context gives the agent the spec, labels the plan, and names no phantom files (F18, finding from the agent's disk search)

**Files:**
- Modify: `apps/vscode/src/tasks/copyContext.ts:22-93` (`buildTaskContext`)
- Test: `apps/vscode/test/unit/copyContext.test.ts`

**Interfaces:**
- Consumes: `client.getStageDocument(projectId, "specify")` (`packages/cloud-client/src/client.ts:425`), existing `specExcerpt` (plan).
- Produces sections in this order: task bullets (now including `Branch: <current branch>` when known and `Web: <task URL>`), `## Acceptance criteria`, `## Specification (excerpt)` from the specify document, `## Implementation plan (excerpt)` from the plan, `## Project coding rules`, `## What to do`. Each excerpt keeps the 4,000-char cap. "## What to do" gains the sentence: "The specification, plan and rules above are the whole context. They are not files in this repository, so do not search the disk for spec.md, plan.md or tasks.md."

- [ ] **Step 1: Write the failing tests**: `labels the plan excerpt as the implementation plan`; `includes the specification from the specify stage document`; `tells the agent not to search for spec files`; heading and "What to do" use the same reference spelling (both the `ref` passed in).
- [ ] **Step 2:** `pnpm --dir apps/vscode test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(vscode): task context carries the spec and a labelled plan excerpt`.

### Task 21: Project Context shows the cloud rules until the repository has them (F18, F25)

**Files:**
- Modify: `apps/vscode/src/context/contextView.ts:81-118,46-54` (when a document is missing on disk and the cloud has it (constitution via `RepoDocs.read`), show its text with the caption "From PromptWorkspace. Not in this repository yet."; hide "Open in editor" for documents missing on disk; wrap the click handler's `openTextDocument` in try/catch with a warning), `:89` empty state → "Link this folder to a project to see its coding rules."
- Modify: `apps/vscode/package.json` `viewsWelcome` (the My Tasks signed-out block becomes "Sign in from the Projects view above to see the tasks assigned to you." without buttons)
- No unit harness for `contextView.ts`; manual check.

- [ ] **Step 1: Implement.**
- [ ] **Step 2:** `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`. Expected: PASS.
- [ ] **Step 3: Manual check:** in the test folder (no `AGENTS.md`), Project Context shows the constitution with the caption and no "Open in editor" on missing files; signed out, only Projects shows sign-in buttons.
- [ ] **Step 4:** Commit `feat(vscode): show cloud rules until the repository carries them`.

### Task 22: MY TASKS marks the task on the current branch; Projects names the environment (F27, F20)

**Files:**
- Modify: `apps/vscode/src/tasks/treeProvider.ts:63-92` (constructor takes `currentBranchRef: () => string | undefined`; a task whose normalised ref equals it gets description prefix `"on this branch · "` and icon `play-circle`), `apps/vscode/src/extension.ts:218-222` (Projects view description appends `· <api host>` when `cfg.apiUrl` differs from `packages/cloud-client/src/defaults.ts`'s production default)
- Create: `apps/vscode/src/tasks/taskRow.ts` with pure `taskDescription(task, opts: {pending: boolean; onBranch: boolean}): string` so it is testable without `vscode`; `treeProvider.ts` calls it
- Test: create `apps/vscode/test/unit/taskRow.test.ts`

- [ ] **Step 1: Write the failing test**: `taskDescription` returns `"on this branch · T001 · In progress"` for onBranch, `"T001 · To do"` otherwise, and appends `" · commit not pushed"` when pending.
- [ ] **Step 2:** `pnpm --dir apps/vscode test`. Expected: FAIL.
- [ ] **Step 3: Implement**; branch ref from the git bridge via `taskRefFromBranch`.
- [ ] **Step 4:** Run tests and typecheck. Expected: PASS.
- [ ] **Step 5: Manual check:** on branch `T1-…`, T001 shows "on this branch"; Projects description shows `promptworkspace-trust-api.truthledgers.com`.
- [ ] **Step 6:** Commit `feat(vscode): mark the task on this branch and show the cloud host`.

---

## Closing

- [ ] Run every suite: `cd apps/cloud && pytest -q && ruff check .`; `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`; `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`; `pnpm --dir packages/cloud-client test`.
- [ ] Re-run the walkthrough on the trust environment after deploying the branch there (plan with inner fences comes back whole; T029-style gaps warn; intent gate; plan approval shows three documents; requester inbox; Start Task notification; link before repository).
- [ ] Update plan 0029 §13: item 14 done; add a row "Plan 0030 deferred items" pointing to the Deferred list below.

### Deploying this branch

Plan approvals made before Task 6 read stale ("Changed since approval") after this branch is deployed, because the approval hash now covers project rules, plan and tasks rather than the plan alone. While `require_plan_approval` is on, repository creation then refuses with `plan_approval_required` until a plan approval is re-requested and approved. Tell the people who approved plans on the trust and production environments before the deploy. The release PR body (`develop` to `main`) must repeat this note.

## Deferred (not in this plan, with reason)

| Finding | Why deferred | Where it goes |
|---|---|---|
| F8 part: register the MCP server from the extension; write the task context to a file agents read | Plan 0029 §13 item 8 (MCP M4) already owns registration; writing into the user's repo needs a decision on ignore rules | Plan 0029 Phase 2 |
| F9 session store in `globalState` | Re-checked in Task 16 first; may already be fixed by the newer build | Task 16 decides |
| F10 part: server-side audit or receipt for Verified | Needs a decision kind or receipt type | D3 |
| F13 part: request waterfall (graph before stage documents) | Needs the Planner to mount without the graph; region latency (Northflank europe-west4 vs Supabase Singapore) dominates | Separate performance task after the region move |
| F12 part: render decision documents as markdown | Diff view is line-based by design | Later |
| F17 Delivery changes vs per-task assignment | Model change; plan 0029 makes the Change the unit | Plan 0029 Phase 1 |
| F24 part: "assigned to you" count on the workspace page | Needs `/me/tasks` per workspace in the web | Later |
| F25 part: "Finish signing in" toast cannot be dismissed | VS Code API has no dismiss; needs a different sign-in UI | Later |
| F26 part: one task-ID spelling across web and editor | Changes what `startTask` writes; needs a grammar decision | Decision first |
| Staging VSIX is hand-patched (display name and defaults) | Needs a build script for environment flavours | Separate task |
| Deduplicate the workspace members fetch on the project page (Planner, DecisionsPanel, PresenceBar each fetch it) | Performance only; needs a shared members provider | Later |
| Members see Planner briefly before the page switches them to Tasks on first load | Needs a neutral skeleton until the landing tab is known | Later |
| Task branch slug: a short first word followed by one long word cuts to `T1-a` | Hard-cut fallback when the last word boundary is very early | Later, with a re-vendor of the engine copy |
| Commit artifact link markup duplicated in TaskDrawer and VerifyConfirmDialog | One shared `ArtifactLink` | Later |
| Task context fetches the spec and plan excerpts one after another | `Promise.all` them | Later |
| Web does not warn on an open intent request whose spec has since changed; the server refuses with readable copy | Needs the latest decision status, not only the derived state | Later |
| Receipts record `subject_stage: "tasks"` beside a hash that covers rules, plan and tasks | Document what the hash covers before customers use the D1 export | Before the D1 export ships |
| `tests/test_request_id.py::test_a_rate_limited_response_still_carries_an_id` fails when a developer's `apps/cloud/.env.local` is present | The suite is not hermetic against `.env.local` | Separate test fix |
| Smaller test gaps logged during review (fence variants, `[P]` lines through path checks, PUT /roles echo, dialog focus trap, Undo from Verified, slug boundaries) | Coverage only; behaviour verified by review | Later |
