# 0032: LINE notifications for a project's team, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Draft, 2026-10-23. Branch `feature/line-notifications`, cut from `feature/trust-outcome` at `5067b81`; merges back into `feature/trust-outcome`, which the trust environment deploys.

**Goal:** A workspace admin links one LINE group to a project; from then on the group gets that project's decision, ready-to-verify and discussion notifications, in the workspace's language, without slowing any request.

**Architecture:** Cloud gains a LINE Messaging API client and a notifier that sends on a small thread pool (never FastAPI `BackgroundTasks`, which `BaseHTTPMiddleware` holds; see N3). A signed webhook links groups by a one-time code typed in the group. Copy lives in one pure module with English and Thai. Existing decision, sweep, task-status and discussion code paths call the notifier next to where they already email. Web gains a workspace language setting and a project settings panel.

**Tech Stack:** FastAPI + pytest + httpx (`apps/cloud`), Postgres migration via `scripts/migrate.py`, Next.js 16 + React 19 + vitest (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-10-23-line-notifications-design.md` (approved 2026-10-23).

## Global Constraints

- Every change lands with a test that fails first. Tests stay hermetic: no network, a recording LINE client, `DATA_BACKEND=memory`.
- Cloud: `ruff check .` clean, line length 100. Web: `tsc --noEmit` and `vitest run` green.
- Never put document text or a discussion body into a LINE message. A changes-requested reason is capped at 200 characters (cut with `…`).
- People are named by their full workspace email; with no hat holder, "any workspace admin" / "ผู้ดูแลเวิร์กสเปซคนใดก็ได้".
- Configuration only from env: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_BOT_BASIC_ID` (optional). Missing secret or token: the feature is off and nothing is sent.
- A LINE failure is logged (never the token) and dropped; it never fails or slows a request. HTTP timeout 5 s.
- The webhook path is `POST /integrations/line/webhook` (already set in the LINE console). It is unauthenticated and signature-verified, and is added to the rate limiter's prefixes.
- English copy: sentence case, no exclamation marks. Thai copy: polite neutral register, no ครับ/ค่ะ. Exact strings are in Task 3.
- One new migration, `0010_pw_line_notifications.sql`, idempotent, header in the style of `0009`.

## Review Focus

1. A LINE API that hangs for 5 s must not delay `POST /projects/{id}/decisions`. Task 2 pins it (`notifier returns before the client finishes`).
2. A redelivered webhook (same event twice) links once and replies once. Task 4 pins it (`redelivered link event links and replies once`).
3. A forged webhook call (bad or missing `X-Line-Signature`) changes nothing. Task 4 pins it.
4. A task already `implemented` that gets `implemented` again sends nothing; web drag and editor close both send exactly one. Task 6 pins it.
5. A project with no linked group, or a server with no LINE configuration, sends nothing and every existing decision and email test still passes. Tasks 2 and 5 pin it.

---

## M1: Cloud foundation

### Task 1: Workspace language and LINE link storage

**Files:**
- Create: `apps/cloud/migrations/0010_pw_line_notifications.sql`
- Modify: `apps/cloud/app/models/schemas.py` (`Workspace` `:264`, `WorkspaceUpdate` `:258`, new models), `apps/cloud/app/db/repository.py` (abstract `Repository` `:127` and `InMemoryRepository`), `apps/cloud/app/db/supabase_repository.py`
- Test: create `apps/cloud/tests/test_line_storage.py`; `tests/contract/` gets the same cases if its fixture pattern makes that a few lines

**Interfaces:**
- Produces:
  - `Workspace.language: Literal["en", "th"] = "en"`; `WorkspaceUpdate.language: Literal["en", "th"] | None = None` (flows through the existing `PATCH /workspaces/{id}`).
  - `class ProjectLineLink(BaseModel): project_id: str; group_id: str; group_name: str | None = None; linked_by: str; linked_at: datetime`
  - `class LineLinkCode(BaseModel): code: str; project_id: str; created_by: str; expires_at: datetime`
  - Repository methods: `get_project_line_link(project_id) -> ProjectLineLink | None`, `set_project_line_link(link: ProjectLineLink) -> ProjectLineLink` (upsert by project), `delete_project_line_link(project_id) -> bool`, `delete_line_links_for_group(group_id) -> int`, `put_line_link_code(code: LineLinkCode) -> None` (deletes any other code for that project first), `take_line_link_code(code: str, now: datetime) -> LineLinkCode | None` (returns and deletes it only if unexpired; an expired one is deleted and `None` returned).
- Migration: `alter table pw_workspaces add column if not exists language text not null default 'en'` with a `check (language in ('en','th'))` constraint added idempotently; tables `pw_project_line_links` and `pw_line_link_codes` as in the spec; RLS enabled and `revoke all … from anon, authenticated` on both new tables (service-only, the `pw_workspace_integrations` secret posture). Header explains deploy order: apply before deploying code that reads `language`.

- [ ] **Step 1: Write the failing tests** in `test_line_storage.py` against `InMemoryRepository`: `test_workspace_language_defaults_to_en_and_updates` (via `PATCH /workspaces/{id}` with `{"language": "th"}`, and 422 for `"fr"`); `test_line_link_upsert_replaces_and_deletes`; `test_delete_links_for_group_clears_every_project_on_it`; `test_link_code_is_single_use_and_expires` (take twice → second `None`; take after `expires_at` → `None`); `test_new_code_replaces_unused_code_for_project`.
- [ ] **Step 2:** Run `cd apps/cloud && pytest tests/test_line_storage.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** models, migration, both repositories. The Supabase adapter writes `language` with the workspace row and uses the service client for the two new tables.
- [ ] **Step 4:** Run `pytest tests/test_line_storage.py tests/test_workspaces*.py -q && ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): workspace language and LINE link storage (migration 0010)`.

### Task 2: LINE client and a notifier that never blocks

**Files:**
- Create: `apps/cloud/app/integrations/line.py`
- Modify: `apps/cloud/app/config.py` (beside the SMTP block `:70`), `apps/cloud/app/main.py` (where `decision_mailer` is built `:242-245`; shut the pool down in the lifespan exit), `docs/DEPLOYMENT.md` (cloud env table: the three `LINE_*` variables, and that the feature is off without them; §2.2 migration list gains 0010)
- Test: create `apps/cloud/tests/test_line_notifier.py`

**Interfaces:**
- Produces in `line.py`:
  - `class LineClient(Protocol)`: `push(to: str, text: str) -> None`, `reply(reply_token: str, text: str) -> None`, `group_name(group_id: str) -> str | None`.
  - `class HttpLineClient(LineClient)` over `httpx.Client(timeout=5.0)`: `POST https://api.line.me/v2/bot/message/push` `{"to": to, "messages": [{"type": "text", "text": text}]}`, `POST https://api.line.me/v2/bot/message/reply`, `GET https://api.line.me/v2/bot/group/{group_id}/summary` → `groupName`; raises on non-2xx; `group_name` returns `None` on any error.
  - `class RecordingLineClient(LineClient)` with `.pushed: list[tuple[str, str]]`, `.replied: list[tuple[str, str]]`, settable `group_names: dict[str, str]`, and an optional `delay: float` for the blocking test.
  - `verify_signature(secret: str, body: bytes, signature: str | None) -> bool` (HMAC-SHA256, base64, `hmac.compare_digest`).
  - `class LineNotifier`: `__init__(client: LineClient | None, repo: Repository, executor: Executor)`; `enabled: bool`; `notify_project(project_id: str, build: Callable[[str], str]) -> None` looks up the project's link and the workspace language **inside the worker**, calls `build(language)` for the text, pushes to the group; does nothing when disabled or unlinked; catches and logs every exception. `send_now(group_id, text)` synchronous (for the settings test message). `shutdown()`.
  - `build_line_notifier(settings, repo) -> LineNotifier` (client `None` when the secret or token is empty; `ThreadPoolExecutor(max_workers=2, thread_name_prefix="line")`).
  - `app.state.line_notifier`, and `Settings.line_channel_secret`, `line_channel_access_token`, `line_bot_basic_id`.

- [ ] **Step 1: Write the failing tests:** `test_verify_signature_accepts_good_rejects_bad_and_missing` (compute the expected value in the test with `hmac`/`base64`); `test_notifier_pushes_built_text_to_linked_group_in_workspace_language` (workspace `th`, `build` receives `"th"`); `test_notifier_does_nothing_when_unlinked_or_disabled`; `test_notifier_returns_before_the_client_finishes` (client `delay=1.0`, `notify_project` returns in under 0.1 s; then wait on the executor and assert the push happened); `test_notifier_swallows_client_errors`. Use a real `ThreadPoolExecutor` and `executor.shutdown(wait=True)` to settle.
- [ ] **Step 2:** Run `pytest tests/test_line_notifier.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tests override `app.state.line_notifier` the way they override `decision_mailer`; add a fixture in `tests/conftest.py` if others need it.
- [ ] **Step 4:** Run `pytest tests/test_line_notifier.py -q && pytest -q && ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): LINE Messaging API client and non-blocking notifier`.

### Task 3: Message copy in English and Thai

**Files:**
- Create: `apps/cloud/app/delivery/line_notices.py`, `apps/cloud/tests/test_line_notices.py`

**Interfaces:**
- Produces pure functions, each `(..., lang: Literal["en","th"]) -> str`, every message starting with the line `[PromptWorkspace] {project}` and links on their own line. `who` is the resolver email or the any-admin phrase. Exact copy (fill `{…}`):

| Function | English | Thai |
|---|---|---|
| `requested(project, kind, who, hat, link, lang)` | `{Intent approval\|Plan approval} is waiting for {who} ({business owner\|tech steward}).` / `Decide here: {link}`. With no holder: `… is waiting for any workspace admin.` | `{การอนุมัติความต้องการ\|การอนุมัติแผนงาน} รอ {who} ({เจ้าของงานฝั่งธุรกิจ\|ผู้ดูแลด้านเทคนิค}) ตัดสินใจ` / `ตัดสินใจที่นี่: {link}`. No holder: `… รอผู้ดูแลเวิร์กสเปซคนใดก็ได้ตัดสินใจ` |
| `changes_requested(project, kind, resolver, reason, link, lang)` | `{resolver} requested changes on the {intent\|plan}.` / `Reason: {reason or "No reason was given."}` / `Review: {link}` | `{resolver} ขอให้แก้ไข{ความต้องการ\|แผนงาน}` / `เหตุผล: {reason or "ไม่ได้ระบุเหตุผล"}` / `ดูรายละเอียด: {link}` |
| `approved(project, kind, resolver, link, lang)` | `{resolver} approved the {intent\|plan}.` / `Open: {link}` | `{resolver} อนุมัติ{ความต้องการ\|แผนงาน}แล้ว` / `เปิดดู: {link}` |
| `reminder(project, kind, who, hat, link, lang)` | `Reminder: {Intent approval\|Plan approval} is still waiting for {who} and expires soon.` / `Decide here: {link}` | `เตือน: {การอนุมัติความต้องการ\|การอนุมัติแผนงาน} ยังรอ {who} ตัดสินใจ และจะหมดอายุเร็วๆ นี้` / `ตัดสินใจที่นี่: {link}` |
| `expired(project, kind, link, lang)` | `Nobody answered the {intent\|plan} approval in time, so it counts as not approved.` / `Ask again: {link}` | `ไม่มีผู้ตัดสินใจ{การอนุมัติความต้องการ\|การอนุมัติแผนงาน}ทันเวลา จึงถือว่าไม่อนุมัติ` / `ส่งขออนุมัติใหม่: {link}` |
| `ready_to_verify(project, ref, title, link, lang)` | `{ref} {title} is implemented and ready to verify.` / `Verify: {link}` | `{ref} {title} ทำเสร็จแล้ว รอการตรวจรับ` / `ตรวจรับที่นี่: {link}` |
| `discussion(project, author, about, link, lang)` | `{author} commented on {about}. Someone may need to answer.` / `Open: {link}` | `{author} แสดงความคิดเห็นใน{about} อาจมีคำถามที่ต้องการคำตอบ` / `เปิดดู: {link}` |
| `linked(project, lang)` (no header line) | `Linked to {project}. This group will get PromptWorkspace notifications for it.` | `เชื่อมกลุ่มนี้กับโปรเจกต์ {project} แล้ว กลุ่มนี้จะได้รับการแจ้งเตือนจาก PromptWorkspace สำหรับโปรเจกต์นี้` |
| `test_message(project, lang)` | `Test message. LINE notifications for this project are working.` | `ข้อความทดสอบ การแจ้งเตือนผ่าน LINE ของโปรเจกต์นี้ใช้งานได้` |

- `about` labels: a task → `{ref} {title}` (both languages); the specification → `the specification` / `ข้อกำหนด`; the plan → `the plan` / `แผนงาน`; anything else → `the project` / `โปรเจกต์`.
- Every interpolated value passes through one helper that replaces CR/LF with a space and trims; titles longer than 80 characters are cut with `…`.

- [ ] **Step 1: Write the failing tests:** one test per row asserting the full English and Thai output for a fixed input; `test_reason_is_capped_at_200_characters`; `test_newlines_in_names_are_flattened`; `test_no_holder_uses_any_admin_phrase`.
- [ ] **Step 2:** Run `pytest tests/test_line_notices.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run it again and `ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): LINE notification copy in English and Thai`.

### Task 4: Webhook and project LINE settings API

**Files:**
- Create: `apps/cloud/app/api/line.py` (router), `apps/cloud/tests/test_line_api.py`
- Modify: `apps/cloud/app/main.py` (include the router beside `integrations.router` `:317`), `apps/cloud/app/ratelimit.py:25` (add `"/integrations/line"` to `_LIMITED_PREFIXES`)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces routes:
  - `POST /integrations/line/webhook` (no auth): read the raw body; 401 `invalid_signature` unless `verify_signature` passes; 200 `{}` for an empty `events` list (LINE "Verify"). For each event: `message` from a group whose text matches `^\s*link\s+(PW-[A-Z0-9]{6})\s*$` (case-insensitive, code upper-cased) → `take_line_link_code`; on success, `set_project_line_link` with `group_name=client.group_name(group_id)` and reply `linked(project, lang)` with the event's `replyToken`; any other message, `join`, `follow`: ignored. `leave` → `delete_line_links_for_group`. Redelivery (`deliveryContext.isRedelivery` true) for a code already taken but whose project is now linked to that same group: no second reply. Always 200 after a valid signature, even when an event fails (logged).
  - `GET /projects/{id}/line` (members) → `{"configured": bool, "connected": bool, "group_name": str | None, "linked_at": datetime | None, "bot_basic_id": str | None}`.
  - `POST /projects/{id}/line/link-code` (admins; 409 `line_not_configured` when off) → `{"code": "PW-XXXXXX", "expires_at": …, "bot_basic_id": …}`; code alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 6 characters, `secrets.choice`, 15-minute expiry.
  - `DELETE /projects/{id}/line` (admins) → 204.
  - `POST /projects/{id}/line/test` (admins; 409 `line_not_connected` when unlinked) → `send_now(group_id, test_message(project, lang))`; 502 `line_send_failed` if LINE errors (the one synchronous call, admin-initiated).

- [ ] **Step 1: Write the failing tests** with a recording client installed on the notifier and a helper that signs bodies with a test secret: `test_webhook_rejects_bad_and_missing_signature` (401, nothing linked); `test_webhook_verify_with_no_events_is_200`; `test_link_command_links_group_and_replies_in_workspace_language`; `test_expired_or_unknown_code_is_ignored_silently`; `test_redelivered_link_event_links_and_replies_once`; `test_ordinary_group_message_is_ignored`; `test_leave_event_clears_link`; `test_link_code_requires_admin_and_configuration`; `test_status_reports_connected_group`; `test_disconnect_and_test_message`.
- [ ] **Step 2:** Run `pytest tests/test_line_api.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pytest tests/test_line_api.py tests/test_request_id.py -q && ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): LINE webhook links a group to a project by code`.

---

## M2: Events

### Task 5: Decisions: requested, changes requested, approved, reminder, expired

**Files:**
- Modify: `apps/cloud/app/api/delivery.py` (`request_decision` beside the email at `:516-518`; `resolve_decision` beside `:588-594`, plus a new approved branch), `apps/cloud/app/delivery/sweep.py` (`sweep_decisions` gains `notifier: LineNotifier | None = None`; expired and reminder branches `:47-65`), `apps/cloud/app/main.py:118` (pass `app.state.line_notifier`)
- Test: `apps/cloud/tests/test_line_events.py` (create)

**Interfaces:**
- Consumes: `LineNotifier.notify_project` (Task 2), `line_notices` (Task 3), `eligible_resolvers` and the members already loaded at each site.
- `who`: the single eligible resolver's email when exactly one non-admin hat holder is routed; otherwise the any-admin phrase. Hat label from `decision.routed_hat`. Kind from `decision.kind`. Link from `notices.decision_link`.

- [ ] **Step 1: Write the failing tests** (install a recording client and a synchronous executor, e.g. a tiny `Executor` that runs inline, so assertions need no waiting): `test_request_pushes_requested_message_naming_the_holder`; `test_request_without_holder_names_any_admin`; `test_changes_requested_pushes_reason`; `test_approval_pushes_approved`; `test_sweep_pushes_reminder_and_expired_once` (run the sweep twice; one reminder total); `test_no_push_when_project_unlinked`; and confirm the existing `tests/test_decisions_api.py` and sweep tests pass untouched.
- [ ] **Step 2:** Run `pytest tests/test_line_events.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pytest tests/test_line_events.py tests/test_decisions_api.py tests/test_decision_rules.py -q && pytest -q -k sweep && ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): LINE messages for decisions`.

### Task 6: Ready to verify, and discussion comments

**Files:**
- Modify: `apps/cloud/app/api/sync.py` (`set_task_status` `:1158-1205`: read the previous status before `repo.set_task_status`; notify only when the new status is `implemented` and the previous one was not), `apps/cloud/app/api/discussions.py` (`create_discussion` `:33`)
- Create: `apps/cloud/app/delivery/line_throttle.py` (`class DiscussionThrottle: allow(project_id: str, node_id: str, now: datetime) -> bool`, at most one `True` per key per 10 minutes, in memory, thread-safe with a lock), instance on `app.state.discussion_throttle`
- Test: `apps/cloud/tests/test_line_events.py` (extend)

**Interfaces:**
- Task link: `{web_app_url}/w/{workspace_id}/p/{project_id}?tab=tasks&task={task_id}`. Discussion link: `…?tab=discussion` (the tab slug from `slugOf("Discussion")` in the web project page; check it). `about` per Task 3 from the parent node: a task uses its `feature_tag` (fallback title) and title; a `spec_documents` node of stage `specify` → specification, `plan` → plan.

- [ ] **Step 1: Write the failing tests:** `test_implemented_transition_pushes_ready_to_verify_once` (in_progress → implemented pushes; implemented → implemented pushes nothing); `test_other_transitions_push_nothing`; `test_discussion_comment_pushes_without_body` (assert the body text is not in the pushed message); `test_discussion_burst_on_one_node_pushes_once_per_10_minutes` (inject `now`); `test_comments_on_two_nodes_push_twice`.
- [ ] **Step 2:** Run `pytest tests/test_line_events.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `pytest tests/test_line_events.py tests/test_sync*.py tests/test_discussions*.py -q && ruff check .`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cloud): LINE messages for ready-to-verify tasks and discussion comments`.

---

## M3: Web

### Task 7: Workspace language setting

**Files:**
- Modify: `apps/web/src/app/w/[workspaceId]/settings/page.tsx` (admins: a select "Language for notifications" with `English` / `ไทย`, saved through `PATCH /workspaces/{id}` `{language}`; members see the value read-only), `apps/web/src/lib/types.ts` (`Workspace.language: "en" | "th"`)
- Test: the settings page test file (create `page.test.tsx` beside it if none exists)

- [ ] **Step 1: Write the failing tests:** `admin changes the notification language` (select ไทย → PATCH body `{"language":"th"}` and the select shows ไทย); `members see the language but cannot change it`.
- [ ] **Step 2:** Run `pnpm --dir apps/web exec vitest run "src/app/w/[workspaceId]/settings"`. Expected: FAIL.
- [ ] **Step 3: Implement**, matching the page's existing form controls.
- [ ] **Step 4:** Run it and `pnpm --dir apps/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): workspace language for notifications`.

### Task 8: Project settings LINE panel

**Files:**
- Create: `apps/web/src/components/project/LineNotificationsPanel.tsx`, `LineNotificationsPanel.test.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/p/[projectId]/settings/page.tsx:44` (render it after `ProjectRolesPanel` for everyone; actions only for admins), `apps/web/src/lib/types.ts` (`ProjectLineStatus`, `LineLinkCode`)

**Interfaces:**
- Consumes the four routes from Task 4. States and exact copy:
  - not configured: "LINE notifications are not set up on this server."
  - not connected (admin): "Send this project's decisions, ready-to-verify tasks and discussion comments to your team's LINE group." button "Connect LINE group". Member: "Not connected to a LINE group."
  - code shown: "1. Add the PromptWorkspace bot to your LINE group{ ( @id ) when bot_basic_id}." "2. Type this in the group: `link PW-XXXXXX`" "The code expires at {time}." button "Check connection" (refetches status) and "Cancel".
  - connected: "Connected to {group_name or "a LINE group"} since {date}." Admin buttons "Send test message" (shows "Test message sent." or the error) and "Disconnect".
  - Polls status every 5 s while a code is shown, stops when connected or the code expires.

- [ ] **Step 1: Write the failing tests** for each state with mocked fetches: `shows setup copy when LINE is not configured`; `admin generates a code and sees the link command`; `switches to connected when the status poll reports a group`; `admin sends a test message`; `admin disconnects`; `members see status without actions`.
- [ ] **Step 2:** Run `pnpm --dir apps/web exec vitest run src/components/project/LineNotificationsPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement**, matching `ProjectRolesPanel`'s structure and styling.
- [ ] **Step 4:** Run it, the settings page tests, and `pnpm --dir apps/web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): connect a project to a LINE group`.

---

## Closing

- [ ] Run every suite: `cd apps/cloud && pytest -q && ruff check .`; `pnpm --dir apps/web typecheck && pnpm --dir apps/web test`.
- [ ] Merge into `feature/trust-outcome` (user approves the push). The user applies migration 0010 to the trust database (`scripts/migrate.py … apply`, `status` shows `Pending (0)`) before the API deploy reads `language`.
- [ ] On trust: LINE console "Verify" returns success; connect the demo group; request an intent approval and see the message arrive within seconds; approve it; move a task to Implemented; post a comment. Switch the workspace to ไทย and repeat one.
- [ ] Add a row to plan 0029 §13 pointing at this plan.

## Deferred

| Item | Why | Where |
|---|---|---|
| Personal (1:1) LINE messages and account linking | Group-per-project covers the demo and most teams | Later, with Mission Control |
| Approve from LINE | Approval needs the web snapshot, receipt and self-approval rules | Plan 0029 phone decisions |
| Retry queue for failed sends | Inbox and email still carry the decision | Later |
| Email and web UI following workspace language | Out of scope for this change | Later |
| Slack / Teams | Seam kept (`LineClient`-shaped protocol) | Later |
| Batch names only authors with a member email; "+N" counts from the shortened list | Final review, 2026-10-23 | Later |
| Discussion message lookups use the request-scoped repository on the worker | Final review, 2026-10-23; fine while the token is valid | Use `app.state.repository` in the closure |
| Smaller review notes: link-code delete+insert race, unbounded throttle and executor queues, panel refresh in-flight guard, tests for cancel/expiry/unmount, workspace language `pending` state | Polish | Later |
