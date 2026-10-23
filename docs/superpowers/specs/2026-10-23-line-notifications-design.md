# LINE notifications for a project's team: design

**Date:** 2026-10-23. **Status:** Approved by the user 2026-10-23 (people named by full workspace email). **Branch:** `feature/line-notifications`, cut from `feature/trust-outcome` at `5067b81`.

## Intent

PromptWorkspace already decides who must act on a decision (the Inbox routes each decision to the business owner, tech steward or an admin) and emails them. People do not live in email or in the web app; Thai teams live in LINE. This feature lets a project's team get PromptWorkspace notifications in the LINE group they already use, so the business owner, tech lead and developers learn within seconds that a decision is waiting, that something was sent back, or that work is ready to verify.

It is also the centrepiece of a presentation to the CEO: he will watch a decision requested on the web arrive in a LINE group and open the decision from there. The CEO's 2026-10-11 architecture (plan 0029 §§ on the Decision Inbox, "notifications to LINE or Slack, deep-linked to a decision") already names this channel; this is its first build.

## Goals

1. A workspace admin connects one LINE group to one project from project settings, once. After that the whole group receives that project's notifications. No one links a personal LINE account.
2. Messages follow the workspace's language: English or Thai.
3. Each message names the project, what happened, who has to act, and links straight to the page where they act.
4. Sending to LINE never slows a web request and never fails one.
5. Works on the trust environment for the CEO demo, with the LINE Official Account the user created ("PromptWorkspace (Trust)"), whose secrets are already set on Northflank `promptworkspace-trust` as `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN`.

## Non-goals

- Personal (1:1) LINE messages and per-user LINE account linking.
- Answering a decision from inside LINE (buttons that approve). Approval stays on the web, where the snapshot, receipt and no-self-approval rules live.
- Slack, Teams or other chat tools. The design keeps a seam for them but builds none.
- Replacing email. Email keeps working as it does (N3 still deferred).
- Notifications in the VS Code extension.

## Anti-goals (a failure even if it technically works)

- A message carries document text (spec, plan, discussion body) into LINE. Plan approval subjects may hold personal data; email already follows this rule (`app/delivery/notices.py` docstring).
- The bot chatters: replies to ordinary group messages, greets, or posts the same event twice.
- Anyone can link a group to a project by guessing a code, or a forged webhook call links or unlinks a group.
- A slow or failing LINE API makes the decision request slow (the N3 mistake again).

## Events that send a LINE message (first set)

| Event | Where it is raised today | Message names |
|---|---|---|
| Decision requested (intent or plan approval) | `request_decision`, `app/api/delivery.py` (the email path at ~516) | kind, project, the routed role and the name/email of the person holding it (or "any workspace admin"), link to the Decisions tab |
| Changes requested | `resolve_decision`, rejected branch (~588) | kind, project, resolver, reason (the resolver's typed rationale is a short note, not the document; cap at 200 characters), link |
| Approved | `resolve_decision`, approved branch (new; email has none) | kind, project, approver, link |
| Reminder, 48 hours before expiry | `app/delivery/sweep.py` reminder branch | kind, project, who must act, link |
| Expired | `sweep.py` expired branch | kind, project, link |
| Task implemented, ready to verify | where a task status becomes `implemented` (single-field status route in `app/api/sync.py`) | task ref and title, project, link to the task |
| New discussion thread or reply | `app/api/discussions.py` create | author, project, "a new question or comment", link to the Discussion tab; never the body |

The discussion row answers the original ask ("a question that needs someone to answer"), which today notifies nobody.

## How a group gets linked

1. Admin opens project settings, section **LINE notifications**, clicks **Connect LINE group**. The web shows a one-time code (`PW-` plus 6 characters from an unambiguous alphabet), valid for 15 minutes, and three steps: add the bot (QR / `@` id shown from env), then type `link PW-XXXXXX` in the group.
2. The bot receives the group message through the webhook. If the text matches a live code, the cloud stores the group id on the project, replies once in the group "Linked to <project>. This group will get PromptWorkspace notifications for it." in the workspace language, and the settings page shows "Connected" with the group's name (from LINE's group summary API) and the date.
3. Any other group message is ignored silently. A `join` event gets no reply (greetings are off in the Official Account too).
4. **Disconnect** removes the link; **Send test message** posts a short test. If the bot is removed from the group (`leave` event) the link is cleared and settings say so.
5. One project has at most one group. One group may serve several projects (each message names its project).

## Constraints and decisions

- **Messaging API, not LINE Notify** (LINE Notify ended 2025-03-31). Push endpoint `POST https://api.line.me/v2/bot/message/push` with the channel access token; reply endpoint for the link confirmation.
- **Webhook** `POST /integrations/line/webhook` on the cloud API, verified with `X-Line-Signature` (HMAC-SHA256 of the raw body with `LINE_CHANNEL_SECRET`, base64, constant-time compare). Unsigned or bad signature: 401 and nothing happens. LINE's "Verify" button sends an empty event list; answer 200.
- **Configuration** from env only: `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `LINE_BOT_BASIC_ID` (the `@xxxx` id shown in setup instructions; optional). Missing secret or token: the feature is off, settings show "LINE is not configured on this server", nothing is sent.
- **Storage.** Migration `0010`:
  - `pw_workspaces.language text not null default 'en' check (language in ('en','th'))`.
  - `pw_project_line_links (project_id uuid primary key references pw_projects on delete cascade, group_id text not null, group_name text, linked_by uuid not null, linked_at timestamptz not null default now())`, service-only grants like `pw_workspace_integrations`' secret column posture: a member must not read another project's group id through PostgREST.
  - Pending link codes: a table `pw_line_link_codes (code text primary key, project_id uuid not null, created_by uuid not null, expires_at timestamptz not null)`, service-only. A table, not memory, so a restart during the demo cannot lose a code. Codes expire in 15 minutes and are burned on first successful use. A new code for the same project replaces any unused one.
  - The in-memory repository mirrors both, for hermetic tests.
- **Workspace language.** A typed field on `Workspace` (`language: Literal["en","th"] = "en"`), editable by admins in workspace settings ("Language for notifications": English / ไทย). It governs LINE messages now; email and the web UI are out of scope for this change.
- **Copy.** Plain text messages (no Flex Messages in this version), one per event, under 5 lines, first line `[PromptWorkspace] <project>`. English sentence case, no exclamation marks; Thai written naturally, polite neutral register, no ครับ/ค่ะ. All strings live in one pure module beside `notices.py` (for example `app/delivery/line_notices.py`) with both languages, tested like `notices.py`.
- **Sending off the request path.** A send is scheduled with `asyncio.create_task` (or a thread for the sync sweep), not FastAPI `BackgroundTasks`, because `app/ratelimit.py` is a `BaseHTTPMiddleware` and would hold the response (N3). HTTP client timeout 5 s. A failure is logged (no token in logs) and dropped; no retry queue in this version.
- **Links** use `WEB_APP_URL` and the same paths email uses (`decision_link` in `notices.py`); task links open the Tasks tab with the task.
- **Who must act** comes from the same routing the Inbox and email use (`eligible_resolvers` in `app/delivery/decisions.py`, reachable from the sweep with the project's roles and members). Messages name people by their workspace email, the only name PromptWorkspace stores; with no hat holder the line reads "any workspace admin".
- **"Ready to verify"** fires when a task moves into `implemented` from any other status through the single-field status route (`PATCH /projects/{id}/tasks/{tid}/status`), which the editor's close, the MCP `close_task` and the web board all use. `implemented` to `implemented` sends nothing. The legacy graph push (`PUT /sync/projects/{id}/graph`) does not notify. One message per task.
- **Discussion throttle.** A new thread always sends. Replies send at most one message per thread per 10 minutes ("3 new replies in <thread> from a@x, b@y"), tracked in memory; a restart may send one extra message, which is acceptable. The author is named; the body never is.
- **Linking rules.** Linking is idempotent (a redelivered webhook links once and replies once). Linking a project that already has a group replaces the old link, because an admin explicitly generated the code. A failed or slow group summary call stores the link with no name ("LINE group") and never blocks the confirmation. `leave` (bot removed, group deleted) clears every link to that group.
- **Workspace language** is edited through the existing `PATCH /workspaces/{id}` and shown on the existing workspace settings page (`apps/web/src/app/w/[workspaceId]/settings/page.tsx`). `pw_workspaces.language` is a plain member-readable column.
- **Shipping.** The branch merges into `feature/trust-outcome` for the demo and later travels with it to `develop` and `main`. The feature is off wherever the `LINE_*` variables are unset. `docs/DEPLOYMENT.md` gains the three variables in the env tables.
- **Permissions.** Only workspace admins can generate a code, disconnect, or send a test. Any member can see whether the project is connected.
- **Tests.** Cloud: signature verification (good, bad, missing), link by code (valid, expired, reused, wrong text ignored), leave clears link, each event schedules exactly one push with the right text in both languages, no push when unlinked or unconfigured, push failure does not fail the request. Web: settings panel states (not configured, not connected, code shown, connected, disconnect), workspace language select. A fake LINE client in tests; no network.
- **Demo path on trust.** The branch merges into `feature/trust-outcome`, which trust deploys; migration 0010 is applied to the trust database by the user (`scripts/migrate.py`, as for 0004–0009). The webhook URL already set in the LINE console is `https://promptworkspace-trust-api.truthledgers.com/integrations/line/webhook`.

## Left to the builder

- Exact module and class names, the fake client shape, and whether link codes live in a table or in memory (see Storage).
- The code alphabet and the exact `link` command parsing (case-insensitive, tolerate surrounding spaces).
- Layout of the settings panel within the existing project settings page, matching its other panels.
- Whether the `implemented` hook sits in the status route or in a shared status-change helper, as long as both the editor's commit close and a web drag fire it once.

## Calls I made (not yet confirmed by the user)

- Group-per-project, linked by a code typed in LINE, rather than the bot posting a code.
- The event set above, including "approved" and "new discussion", and excluding "role assigned" (it is about one person).
- Discussion messages never include the body; changes-requested messages include the resolver's reason capped at 200 characters.
- Workspace language governs LINE only for now.
- Link codes in a table rather than memory; discussion replies throttled to one message per thread per 10 minutes; "ready to verify" only from the single-field status route and only on a transition.
- No retry queue; a lost LINE message is acceptable because the Inbox and email still carry the decision.
