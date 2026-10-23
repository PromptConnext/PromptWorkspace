# 0031: Fixes from the second end-to-end walkthrough (2026-10-18 to 2026-10-19), Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Draft, 2026-10-23. Branch `fix/e2e-walkthrough-0031`, cut from `feature/trust-outcome` at `98b0667` (plan 0030 merged there via PR #18).

**Goal:** Fix what the second walkthrough on the trust environment found, so that a developer who switches between environments keeps their sign-in and their queued task updates, generated documents carry no template text, the extension builds from a clean checkout, and requesters can find and read the decisions sent back to them.

**Architecture:** Five milestones. Each one can ship on its own. M1 scopes the editor's session and status queue to one environment, in `packages/cloud-client` and `apps/vscode`. M2 removes the leaking template text from the cloud templates and the post-processor. M3 commits the extension icon and adds a test that keeps it committed. M4 is web polish (Inbox reach, markdown tables). M5 is extension and Planner polish.

**Tech Stack:** FastAPI + pytest (`apps/cloud`), Next.js 16 + React 19 + vitest (`apps/web`), VS Code extension on `node --test` (`apps/vscode`), shared `packages/cloud-client` on `node --test`.

**Spec:** Findings file `promptconnext-projects/local/2026-10-19-e2e-walkthrough-2-findings.md` (umbrella repo, gitignored). Finding numbers N1–N14 below refer to it.

## Global Constraints

- Every change lands with a test that fails first, except where a task says the code has no test harness (files that import `vscode` at runtime). Those tasks get a manual check step.
- Cloud: `ruff check .` clean, line length 100. Tests stay hermetic (`DATA_BACKEND=memory`).
- Web: `tsc --noEmit` and `vitest run` green.
- Extension: no `typeof vscode.` feature detection (`scripts/check-feature-detection.mjs`); no sidecar (ADR 0019); settings only through `promptworkspace.*`.
- `packages/cloud-client` stays free of `import * as vscode`. `apps/mcp` keeps working unchanged: everything new in `SessionStore` and `StatusQueue` is optional and defaults to today's behaviour.
- `packages/cloud-client/src/taskRefs.ts` is not changed by this plan, so the engine copy needs no re-vendoring.
- Copy is plain English, sentence case, no exclamation marks. Dates absolute.
- No new migration.

## Decisions this plan takes (confirm before M1)

1. **Session scope (N1).** A session belongs to one environment. The environment is identified by the host of `promptworkspace.supabaseUrl`, or by the host of `promptworkspace.cloudApiUrl` when there is no Supabase URL (stub mode). Two windows on the same environment still share one session and one refresh lease, as today. A window never reads, refreshes or clears another environment's session.
2. **Upgrading from 0.3.0.** The unscoped session left by 0.3.0 is moved to the environment whose Supabase host matches the access token's `iss` claim. The first window on that environment moves it. Windows on other environments show "Signed out" and do not touch it.
3. **Queue ownership (N2).** A queued status write belongs to the environment and the user that made it. An involuntary sign-out keeps the queue. An explicit Sign Out drops this environment's entries, after the existing confirmation. A different user signing in to the same environment drops the previous user's entries. Entries written by 0.3.0, which have no owner, are flushed by the first signed-in window, as they would have been before.
4. **Decision email (N3) and the trust outage (N4) are out of scope.** The user decided on 2026-10-19 to leave decision email as it is, and N4 needs the Northflank logs first. The release note for PR #17 keeps the warning that every decision request can wait up to 10 seconds on an environment with SMTP configured. See Deferred.
5. **Environment label (N1, third part).** Already shipped: plan 0030 Task 22 shows the cloud host in the Projects view whenever it is not production (`apps/vscode/src/util/environment.ts`). There is no task for it here.

## Review Focus

1. A 0.3.0 user upgrades with one Supabase session stored and three windows open on two environments. Exactly one environment ends up signed in, and nothing errors in the other windows. Task 1 pins it (`adopts a legacy session only into the environment that minted it`).
2. Two windows on the same environment must still make one refresh call and end with one valid session. The existing lease tests in `packages/cloud-client/test/client.test.ts` must pass unchanged apart from the lease interface. Task 1 pins it (`two windows on one environment still share one session`).
3. Changing `promptworkspace.cloudApiUrl` or `supabaseUrl` in a signed-in window must re-render that window against the new environment's session, or show it signed out. It must never keep showing the old environment's account. Task 3 pins it with a manual check, because the wiring imports `vscode`.
4. A queue persisted by 0.3.0 (entries with no `scope` or `userId`) must flush after the next sign-in. It must not be dropped or left stuck. Task 2 pins it (`entries without an owner belong to every owner`).
5. A model that writes the old template labels inside the plan's fenced project tree must still have them removed. The stripper skips fenced code for every other rule. Task 4 pins it (`drops option labels inside the project tree fence`).

---

## M1: One session and one queue per environment (N1, N2)

### Task 1: SessionStore keys its secrets, record and refresh lease by environment

**Files:**
- Modify: `packages/cloud-client/src/session.ts` (key constants at `:103-105`, `SessionStore` constructor `:126-134`, `clearIfRefreshToken` `:174-179`, lease methods `:181-198`, `LeaseStorageLike` `:51-54`, `memoryLeaseStorage` `:58-68`, `fileLeaseStorage` `:76-98`)
- Test: `packages/cloud-client/test/client.test.ts` (update the lease fakes to the new interface) and create `packages/cloud-client/test/session.test.ts`

**Interfaces:**
- Produces:
  - `environmentScope(cfg: { supabaseUrl: string; apiUrl: string }): string`. Returns the lower-cased host of `supabaseUrl` when it parses, else the host of `apiUrl`, else `""`.
  - `issuerHost(accessToken: string): string | undefined`. Returns the host of the JWT's `iss` claim. It is for display and routing only, never an auth decision, like `emailFromAccessToken`.
  - `new SessionStore(secrets, state, leases = memoryLeaseStorage(), scope: () => string = () => "")`. Each key is `${base}@${scope()}` when the scope is not empty, otherwise the bare 0.3.0 key. So `apps/mcp`, which passes no scope, is unchanged.
  - `SessionStore.adoptLegacySession(): Promise<boolean>`. Does nothing and returns false when the scope is `""`, a scoped record already exists, or no unscoped record exists. When the unscoped record has `mode: "supabase"` and `issuerHost(unscoped access token) === scope()`, or has `mode: "stub"`, it copies both tokens and the record under the scoped keys, deletes the unscoped ones, emits the session and returns true. Otherwise it leaves everything alone and returns false.
  - `SessionStore.rescope(): void`. Emits `read()` under the current scope. Callers use it after a settings change.
  - `LeaseStorageLike` becomes `read(scope: string)` and `write(scope: string, lease: RefreshLease | undefined)`. `memoryLeaseStorage` keeps one lease per scope. `fileLeaseStorage` writes `refresh-lease.json` for `""` and `refresh-lease@<scope>.json` otherwise. A host is safe in a file name.

- [ ] **Step 1: Write the failing tests** in `session.test.ts`, using the in-memory secrets and state helpers from `client.test.ts` (move them to `test/helpers.ts` if they are not exported):
  - `environmentScope prefers the Supabase host`: `environmentScope({supabaseUrl: "https://abc.supabase.co", apiUrl: "https://api.x"}) === "abc.supabase.co"`. With `supabaseUrl: ""` it returns `"api.x"`. With both empty, or both unparsable, it returns `""`.
  - `issuerHost reads the iss claim`: a token whose payload is `{"iss":"https://abc.supabase.co/auth/v1"}` gives `"abc.supabase.co"`. A token with no payload gives `undefined`.
  - `stores under the scope and reads nothing from another scope`: two stores over one shared secrets and state, scopes `"a.supabase.co"` and `"b.supabase.co"`. Store a session in A. `B.read()` is `null` and `B.accessToken()` is `undefined`. `B.clear()` leaves `A.read()` intact.
  - `clearIfRefreshToken only clears its own scope`: A and B both hold sessions. `B.clearIfRefreshToken(<B's token>)` returns true and `A.refreshToken()` is unchanged.
  - `adopts a legacy session only into the environment that minted it`: put the unscoped keys in place with an access token whose iss host is `a.supabase.co`. `B.adoptLegacySession()` resolves false and the unscoped keys remain. `A.adoptLegacySession()` resolves true, `A.read()` equals the legacy record, and the unscoped keys are gone. A second call resolves false.
  - `an empty scope keeps the 0.3.0 keys`: with the default scope, `store()` writes `promptworkspace.cloud.session` exactly, which is the `apps/mcp` path.
  - `leases are per scope`: `memoryLeaseStorage()` writes a lease for `"a"`, and `read("b")` is `undefined`. `fileLeaseStorage` over a fake file map writes `refresh-lease@a.supabase.co.json`.
  - In `client.test.ts`, add `two windows on one environment still share one session`. This is the existing "two clients over one store make one refresh call" setup with both stores given the same non-empty scope. Expect one refresh call.
- [ ] **Step 2:** Run `pnpm --dir packages/cloud-client test`. Expected: FAIL (functions not exported).
- [ ] **Step 3: Implement** as in Interfaces. Update the existing lease fakes in `client.test.ts` (`:532-805`) to the `(scope, …)` signatures.
- [ ] **Step 4:** Run `pnpm --dir packages/cloud-client test && pnpm --dir apps/mcp test && pnpm --dir apps/mcp typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud-client): scope the session and refresh lease to one environment`.

### Task 2: Queued status writes carry their environment and user

**Files:**
- Modify: `packages/cloud-client/src/queue.ts` (`QueueEntry` `:15-24`, `flush` `:99-130`, new methods beside `clear` `:140`)
- Test: `packages/cloud-client/test/queue.test.ts`

**Interfaces:**
- Produces:
  - `QueueEntry` gains `scope?: string` and `userId?: string`. `enqueue` keeps its parameter type, so both fields stay optional there.
  - `belongsTo(scope: string, userId: string | undefined): (e: QueueEntry) => boolean` returns true when `(e.scope === undefined || e.scope === scope) && (e.userId === undefined || e.userId === userId)`.
  - `StatusQueue.flush(flusher, belongs?: (e: QueueEntry) => boolean)`. Entries for which `belongs` is false survive untouched, with no attempt and no backoff change. With no `belongs`, every entry is eligible, which is the `apps/mcp` path.
  - `StatusQueue.count(belongs?: (e: QueueEntry) => boolean): number`.
  - `StatusQueue.drop(predicate: (e: QueueEntry) => boolean): Promise<number>`. Removes the matching entries, persists, and returns how many it removed.
  - Dedupe in `enqueue` also matches on `scope`. The same task id on two environments gives two entries.

- [ ] **Step 1: Write the failing tests**
  - `flush skips entries that belong to another environment`: enqueue one entry with scope `a`/user `u1` and one with `b`/`u1`. `flush(f, belongsTo("a","u1"))` calls `f` once. The `b` entry keeps `attempts === 0`.
  - `entries without an owner belong to every owner`: an entry with neither field is flushed under `belongsTo("a","u1")`.
  - `drop removes another user's entries and reports the count`: `drop(e => e.scope === "a" && e.userId !== undefined && e.userId !== "u2")` returns 1 and leaves the `b` entry.
  - `the same task on two environments queues twice`.
  - `count filters by owner`.
- [ ] **Step 2:** Run `pnpm --dir packages/cloud-client test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pnpm --dir packages/cloud-client test && pnpm --dir apps/mcp test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud-client): queued status writes belong to an environment and a user`.

### Task 3: The extension uses the scoped session and keeps the queue through an involuntary sign-out

**Files:**
- Modify: `apps/vscode/src/extension.ts` (`SessionStore` construction `:55-59`, status bar `:86-95`, `session.onDidChange` `:368-389`, `onDidChangeConfiguration` `:420`, `promptworkspace.signOut` `:444-457`, `renderConnection` `:267`)
- Modify: `apps/vscode/src/tasks/statusWriter.ts` (constructor `:34-40` gains `owner: () => { scope: string; userId?: string }`; `enqueue` at `:86` writes `scope` and `userId`; `flush` passes `belongsTo(owner().scope, owner().userId)`)
- Modify: `apps/vscode/src/auth/status.ts` (`SessionSignal` gains `queued: number`; the `signed_out` message at `:74-76` appends a sentence when `queued > 0`)
- Test: `apps/vscode/test/unit/status.test.ts`

**Interfaces:**
- Consumes: `environmentScope`, `SessionStore.adoptLegacySession`, `SessionStore.rescope` (Task 1), and `belongsTo`, `StatusQueue.count`, `StatusQueue.drop` (Task 2).
- Produces: the signed-out message suffix `" <N> task update(s) are kept and will be sent after you sign in."`. Use "1 task update is kept" for N = 1.

- [ ] **Step 1: Write the failing tests** in `status.test.ts`: `signed out with queued updates says they are kept` (queued 2 gives a message ending `2 task updates are kept and will be sent after you sign in.`), and `signed out with an empty queue says nothing about updates`.
- [ ] **Step 2:** Run `pnpm --dir apps/vscode test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `const scope = () => environmentScope(readConfig())`. Pass it as the fourth `SessionStore` argument, and `await session.adoptLegacySession()` right after construction.
  - Keep `let lastUserId = session.read()?.userId` up to date in the session listener.
  - On a configuration change that `affectsConfiguration("promptworkspace.cloudApiUrl")` or `("promptworkspace.supabaseUrl")`: `await session.adoptLegacySession(); session.rescope();`.
  - Session listener, signed in: first `await queue.drop(e => e.scope === scope() && e.userId !== undefined && e.userId !== current.userId)`, then the existing refresh and flush chain.
  - Session listener, signed out: replace the unconditional `queue.clear()` with `if (signingOut) await queue.drop(belongsTo(scope(), lastUserId))`. Leave the queue alone otherwise.
  - Status bar, the signOut modal and `connectionState`'s `queued` all use `queue.count(belongsTo(scope(), session.read()?.userId ?? lastUserId))`.
  - Update the `SessionStore.clear` doc comment in `session.ts`, which still says callers must drop the queue on every clear.
- [ ] **Step 4:** Run `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`. Expected: PASS.
- [ ] **Step 5: Manual check** with a VSIX built from this branch (see Task 6 for the icon) and installed in Cursor. Open window A on a folder with trust settings and window B with develop defaults. Sign in to both.
  1. Reload both. Both stay signed in, and A's Projects view shows the trust host.
  2. In A, go offline, Start a task, go online, and sign B out explicitly. A stays signed in, and its queued write reaches trust.
  3. In A, change `promptworkspace.cloudApiUrl` and `supabaseUrl` to develop. A shows B's develop account, or signed out, never the trust account.
  4. Sign A out of trust while a write is queued. The modal counts only trust entries.
- [ ] **Step 6:** Commit `fix(vscode): one session per environment; keep queued updates through an involuntary sign-out`.

---

## M2: Generated documents without template text (N6)

### Task 4: Remove the leaking template text, and strip it when a model reproduces it

**Files:**
- Modify: `apps/cloud/app/generation/templates/plan-template.md`. In the header `:3`, drop `**Branch**` and `**Spec**` and keep `**Date**: [DATE]`. Replace the three-option tree `:54-81` with one placeholder tree headed `# [Replace with the concrete layout for this feature]`. At `:92-96`, replace the "Fill ONLY…" line with an HTML comment: "Leave this section out unless the Constitution Check lists a violation."
- Modify: `apps/cloud/app/generation/templates/tasks-template.md`. Delete the "Path Conventions" section `:16-21`. Rename the headings `:77, :103, :125` to `### Tests for User Story N`, each followed by the comment `<!-- Only when the specification or constitution asks for tests; otherwise leave out this heading. -->`. Delete the "Parallel Example" section `:190-203` through its closing `---`.
- Modify: `apps/cloud/app/generation/parsing.py` (`strip_spec_kit_boilerplate` `:212-251`)
- Test: `apps/cloud/tests/test_generation_parsing.py`, `apps/cloud/tests/test_generation_prompts.py` (must stay green)

- [ ] **Step 1: Write the failing tests** in `test_generation_parsing.py`, one input per test, each asserting on `strip_spec_kit_boilerplate(doc)`:
  - `test_drops_option_labels_inside_the_project_tree_fence`: a ```` ```text ```` fence holding `# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)`, then `backend/`. The output keeps `backend/` and has no line containing `Option 2:`. Another line inside the fence, `# comment`, survives.
  - `test_drops_branch_and_spec_header_line`: `**Branch**: \`001-clinic\` | **Date**: 2026-10-18 | **Spec**: https://example.com/specs/001` before the first `## `. The output has no `example.com` and no `**Branch**`. A `**Branch**` line after the first `## ` survives.
  - `test_drops_fill_only_if_note`: `> **Fill ONLY if Constitution Check has violations that must be justified**` is removed.
  - `test_drops_path_conventions_section`: `## Path Conventions` and its four bullets are removed, and the next `## Phase 1` heading survives.
  - `test_unwraps_optional_tests_heading`: `### Tests for User Story 2 (OPTIONAL - only if tests requested) ⚠️` becomes `### Tests for User Story 2`.
  - `test_drops_parallel_example_section`: `## Parallel Example: User Story 1`, its fenced block and the text up to the next `## ` are removed.
- [ ] **Step 2:** Run `cd apps/cloud && pytest tests/test_generation_parsing.py -q`. Expected: the six new tests FAIL.
- [ ] **Step 3: Implement.** Section drops (`## Path Conventions`, `## Parallel Example…`) skip lines until the next line starting with `## `. Fences inside a dropped section are dropped with it, so track the fence state while skipping. The one rule that applies inside a fence is the option label: a line matching `^#\s*(\[REMOVE IF UNUSED\]\s*)?Option \d+:` is dropped. The header rule drops a line starting `**Branch**:` only while `in_header`. Edit both templates as in Files.
- [ ] **Step 4:** Run `pytest tests/test_generation_parsing.py tests/test_generation_prompts.py tests/test_generation.py tests/test_repo_seed.py -q`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud): drop the remaining Spec Kit template text from plans and task lists`.

### Task 5: Acceptance criteria name only files that exist or that a task creates

**Files:**
- Modify: `apps/cloud/app/generation/prompts.py` (new `TASKS_AC_FILES_RULE` beside `NO_CI_FIRST_TASK_RULE` `:60`, appended for `kind == "tasks"` in `driver_prompt`, for both new and existing codebases)
- Test: `apps/cloud/tests/test_generation_prompts.py`

- [ ] **Step 1: Write the failing test** `test_tasks_prompt_limits_acceptance_criteria_to_real_files`. `driver_prompt("tasks")` and `driver_prompt("tasks", existing_codebase=True)` both contain `TASKS_AC_FILES_RULE`. `driver_prompt("plan")` does not.
- [ ] **Step 2:** Run `pytest tests/test_generation_prompts.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Exact rule text:
  `"An acceptance criterion may name a file only if the plan names it, the repository has it, or an earlier task creates it. Otherwise describe the outcome without a file name."`
- [ ] **Step 4:** Run `pytest tests/test_generation_prompts.py -q`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cloud): acceptance criteria name only real or created files`.

---

## M3: The extension builds from a clean checkout (N7)

### Task 6: Commit the icon and test that every manifest file is tracked

**Files:**
- Modify: `.gitignore` (after `*.png` at `:19`, add `!apps/vscode/media/prompt-connext.png`)
- Add: `apps/vscode/media/prompt-connext.png` (the file already exists locally, copied from the 2026-10-04 VSIX)
- Create: `apps/vscode/test/unit/manifest.test.ts`

- [ ] **Step 1: Write the failing test** `every file the manifest names is committed`. Read `apps/vscode/package.json` and collect `icon` plus every `contributes.viewsContainers.*[].icon` that is a path (not `$(…)`). Assert each one exists on disk and that `git ls-files --error-unmatch <path>`, run with `execFileSync` from the package directory, exits 0.
- [ ] **Step 2:** Run `pnpm --dir apps/vscode test`. Expected: FAIL on `media/prompt-connext.png` (not tracked).
- [ ] **Step 3: Implement.** Add the `.gitignore` exception, then `git add apps/vscode/media/prompt-connext.png`.
- [ ] **Step 4:** Run `pnpm --dir apps/vscode test`. Expected: PASS. CI already runs this suite in the `vscode` job (`.github/workflows/ci.yml:155-171`).
- [ ] **Step 5:** Commit `fix(vscode): commit the extension icon so a clean checkout packages`.

---

## M4: Web: Inbox reach and markdown tables (N9, N10)

### Task 7: Document Preview and the editor render GitHub-flavoured markdown

**Files:**
- Modify: `apps/web/package.json` (add `remark-gfm` at the current major, compatible with `react-markdown` ^10)
- Modify: `apps/web/src/components/project/DocumentPreview.tsx`, `apps/web/src/components/ui/MarkdownEditor.tsx` (`remarkPlugins={[remarkGfm]}` on each `ReactMarkdown`). `AssistantPanel.tsx` gets the same, for consistency.
- Test: `apps/web/src/components/ui/MarkdownEditor.test.tsx`, create `apps/web/src/components/project/DocumentPreview.test.tsx`

- [ ] **Step 1: Write the failing tests** `renders a markdown table as a table` in both files. The input `"| A | B |\n|---|---|\n| 1 | 2 |"` produces `getByRole("table")` with a cell `"2"`.
- [ ] **Step 2:** Run `pnpm --dir apps/web exec vitest run src/components/ui/MarkdownEditor.test.tsx src/components/project/DocumentPreview.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `pnpm --dir apps/web add remark-gfm` and wire the plugin.
- [ ] **Step 4:** Run the same command, then `pnpm --dir apps/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(web): render markdown tables in previews`.

### Task 8: The Inbox is reachable from every project page and counts items sent back

**Files:**
- Create: `apps/web/src/components/InboxLink.tsx`, exporting `InboxLink({ workspaceId }: { workspaceId: string })`. It fetches `/me/decisions?workspace_id=…&include_mine=true` with `useCloudGet` (`refreshOnFocus: true`) and renders `Inbox · N` when N > 0, else `Inbox`, linking to `/w/{workspaceId}/inbox`.
- Modify: `apps/web/src/app/w/[workspaceId]/page.tsx:64-69,106-111` (use `InboxLink` instead of its own fetch and link)
- Modify: `apps/web/src/components/TopBar.tsx:18-23` (optional prop `inboxWorkspaceId?: string`; when set, render `InboxLink` before the account menu)
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx:237` (pass `inboxWorkspaceId={workspaceId}`)
- Test: create `apps/web/src/components/InboxLink.test.tsx`; update `apps/web/src/app/w/[workspaceId]/page.test.tsx` if it asserts the old link

- [ ] **Step 1: Write the failing tests** in `InboxLink.test.tsx`, mocking `useCloudGet` the way the inbox page test does:
  - `counts waiting and sent-back decisions`: one item with status `open` and one with status `rejected` render `Inbox · 2`.
  - `shows plain Inbox when nothing waits`.
  - `requests the sent-back items`: the requested path ends with `&include_mine=true`.
  - In `p/[projectId]/page.test.tsx`: `project top bar links to the Inbox`.
- [ ] **Step 2:** Run `pnpm --dir apps/web exec vitest run src/components/InboxLink.test.tsx "src/app/w/[workspaceId]"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run the same command and `pnpm --dir apps/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): Inbox link on project pages, counting decisions sent back`.

### Task 9: A sent-back card says who sent it back and when

**Files:**
- Modify: `apps/cloud/app/api/me.py`. `InboxItem` gains `resolver_email: str | None = None`. For an `include_mine` item, fill it from the workspace members' email for `d.resolved_by`, loading `members` once per workspace with the same lazy read the open-decision branch uses.
- Modify: `apps/web/src/lib/types.ts:783-791` (`InboxItem.resolver_email?: string | null`)
- Modify: `apps/web/src/app/w/[workspaceId]/inbox/page.tsx:60-70` (under the project name: `Sent back by <email> on <resolved_at as toLocaleString()>`. With no email, `Sent back on <date>`.)
- Test: `apps/cloud/tests/test_decisions_api.py` (beside the existing `include_mine` tests), `apps/web/src/app/w/[workspaceId]/inbox/page.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - cloud `test_include_mine_names_the_resolver`: the sent-back item's `resolver_email` equals the approver's member email.
  - web `names who sent the decision back and when`: an item with `resolver_email: "b@x.com"` and `resolved_at` renders text starting `Sent back by b@x.com on`.
- [ ] **Step 2:** Run `cd apps/cloud && pytest tests/test_decisions_api.py -q -k include_mine` and `pnpm --dir apps/web exec vitest run "src/app/w/[workspaceId]/inbox"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run both again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud,web): sent-back decisions name the resolver and the date`.

---

## M5: Extension and Planner polish (N5, N11, N12, N13)

### Task 10: Copy Task Context shows progress, fetches in parallel and says what is missing

**Files:**
- Modify: `apps/vscode/src/tasks/copyContext.ts` (`buildTaskContext` `:28-93`, `specifyExcerpt` `:~110`, `planExcerpt` `:~125`)
- Modify: `apps/vscode/src/extension.ts:515-535` (wrap the build in `vscode.window.withProgress({ location: Notification, title: "Copying task context…" })`; the final message names missing parts)
- Test: `apps/vscode/test/unit/copyContext.test.ts`

**Interfaces:**
- Produces: `buildTaskContext(entry, client, docs, log, extra): Promise<TaskContext>` where `interface TaskContext { text: string; missing: ("specification" | "plan" | "rules")[] }`. `TaskContextExtra` gains `timeoutMs?: number` (default `5000`). A fetch that throws or does not settle within `timeoutMs` adds its part to `missing`. A document that does not exist is not "missing", because nothing is lost. The three fetches run with `Promise.all`. The message is `Copied context for <tag>.`, or, with missing parts, `Copied context for <tag> without the <parts joined with " and ">. PromptWorkspace did not answer in time.`

- [ ] **Step 1: Write the failing tests**
  - `fetches the specification, plan and rules in parallel`: a fake client whose three reads each wait 50 ms finishes in under 120 ms.
  - `a read slower than the timeout is reported missing and the rest is copied`: with `timeoutMs: 20` and a plan read that never settles, `missing` is `["plan"]` and `text` still contains `## Specification (excerpt)`.
  - `an absent document is not missing`: the specify document returns 404, so `missing` is `[]`.
  - Update the existing tests to read `.text`.
- [ ] **Step 2:** Run `pnpm --dir apps/vscode test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(vscode): Copy Task Context shows progress and names missing parts`.

### Task 11: Regenerating tasks names the tasks it retired

**Files:**
- Modify: `apps/cloud/app/generation/stage_apply.py` (`StageApplyResult` gains `retired_refs: list[str] | None = None` beside `retired_count` `:115`; `_apply_tasks` `:395-430` collects the `feature_tag` of each retired row, with title as a fallback; it is threaded through `_project` the same way `retired_count` is)
- Modify: `apps/cloud/app/api/generation.py:369` and `apps/cloud/app/api/stage_documents.py:53,109` (send `retired_refs`)
- Modify: `apps/web/src/components/project/Planner.tsx:503,532` (`, 2 retired (T003, T004)`; at most five refs, then `and N more`); add `retired_refs` to the result and document types in `apps/web/src/lib/types.ts`
- Test: `apps/cloud/tests/test_stage_regeneration.py`, `apps/web/src/components/project/Planner.test.tsx`

- [ ] **Step 1: Write the failing tests**
  - cloud `test_regeneration_reports_retired_refs`: a board with T001–T004, regenerated with T001–T002, gives `retired_refs == ["T003", "T004"]`.
  - web `names the retired tasks`: result `{task_count: 2, retired_count: 2, retired_refs: ["T003","T004"]}` renders `2 tasks on the board, 2 retired (T003, T004)`. With seven refs it renders the first five and `and 2 more`.
- [ ] **Step 2:** Run `cd apps/cloud && pytest tests/test_stage_regeneration.py -q` and `pnpm --dir apps/web exec vitest run src/components/project/Planner.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Factor the label into a pure `retiredLabel(count: number, refs?: string[]): string` in `Planner.tsx`, or in a sibling file if `Planner.tsx` has no pure helpers. Both call sites use it.
- [ ] **Step 4:** Run both again. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud,web): name the tasks a regeneration retired`.

### Task 12: Start Task says "Create branch" and runs once per click

**Files:**
- Modify: `apps/vscode/src/tasks/startTask.ts:170` (label `$(git-branch) Create and switch to branch <branch>`. When `branch` already exists locally, use `$(git-branch) Switch to branch <branch>`, checked with `git.findBranch(root, branch)`, the same call `ensureTaskBranch` makes in `tasks/taskBranch.ts:29`.)
- Modify: `apps/vscode/src/extension.ts:536-548` (an in-flight `Set<string>` keyed by `project_id:task_id`; a second invocation while the first runs returns at once and logs `start already running for <ref>`)
- No unit harness for these files (both import `vscode`); manual check below.

- [ ] **Step 1: Implement.** First find out where the second `started T2 (branch)` log at 2026-10-18 02:15:36Z came from: the inline play button, the task actions menu (`extension.ts:498`) or the tree item's command. Write the cause in the commit body. The guard goes in either way.
- [ ] **Step 2:** Run `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`. Expected: PASS.
- [ ] **Step 3: Manual check:** on a new task, the picker reads "Create and switch to branch T3-…". Clicking Start twice quickly logs one `started` line and one `start already running`. On the same task again, the picker reads "Switch to branch T3-…".
- [ ] **Step 4:** Commit `fix(vscode): Start Task names what the branch option does and runs once`.

---

## Closing

- [ ] Run every suite: `cd apps/cloud && pytest -q && ruff check .`; `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`; `pnpm --dir apps/vscode typecheck && pnpm --dir apps/vscode test`; `pnpm --dir packages/cloud-client test`; `pnpm --dir apps/mcp typecheck && pnpm --dir apps/mcp test`.
- [ ] `vsce package --no-dependencies` from a fresh clone of the branch (with the defaults filled as `assert-defaults-filled.mjs` requires). It finds the icon.
- [ ] Re-run the walkthrough on trust after deploying the branch there. Check that the generated plan and tasks carry none of the N6 strings, that the preview renders the Complexity Tracking table, that the Inbox link and count work from a project page, and that the Task 3 manual check passes. Retry N14 by hand once: if the first Generate click on the Tasks step still sends nothing without the walkthrough tooling, add it to Deferred as a real bug.
- [ ] Update plan 0029 §13 row 23: mark it done and list anything moved to Deferred.

## Deferred (not in this plan, with reason)

| Finding | Why deferred | Where it goes |
|---|---|---|
| N3 decision requests take about 10 s; no decision email arrives | User decision 2026-10-19: leave email as it is. The likely fix is to send mail off the request path, or to make `app/ratelimit.py` pure ASGI the way `app/requestlog.py` is. It still matters for PR #17: on an environment with SMTP configured, every decision request can wait up to 10 s | Before or with the PR #17 release, when the user reopens it |
| N3 part: tell admins "email not configured" or "last send failed" | Same decision | With N3 |
| N4 trust API restart, 2026-10-18 about 02:14 to 02:16:37Z | Needs the Northflank logs for that window first. Then add memory and event-loop lag to `/health` | Separate investigation |
| N8 Planner blank for about 15 s on trust | Region latency (Northflank europe-west4, Supabase Singapore). Same as plan 0030's F13 deferral | After the region move |
| N9 part: decisions in the editor | Product decision | Plan 0029 Phase 2 |
| Build script for environment-flavoured VSIXs (staging and trust defaults and labels) | Carried from plan 0030 Deferred. Packaging in CI also needs it, because `vscode:prepublish` refuses placeholder defaults | Separate task |
| `apps/mcp` session scope | One process reads one config file, so there is no cross-window clash. Revisit if MCP gains per-call environments | Later |
