# Plan — apps/engine: desktop client for the cloud sync API

**Date:** 2026-07-10 · **Status:** Proposed · **Scope:** `apps/engine` (+ `apps/desktop` UI)
**Depends on:** `apps/cloud` M1–M7 (all shipped, see `apps/cloud/README.md`)
**Depth:** implementation-ready · Milestones **D1–D4**.

## Why this is the next milestone

`apps/cloud` is fully built and tested (50 tests, ruff clean) but has **zero
consumers**. The desktop app is Tauri-shell + a local Node/Hono "engine"
(`apps/engine`) that owns all business logic and a local SQLite task graph
(`apps/engine/src/db.ts` — `projects`, `requirements`, `spec_documents`,
`tasks`, `acceptance_criteria`, `artifacts`, `agent_runs`, `integrations`,
`stage_states`). Today collaboration is git-log-only: `syncTasksFromGit`
(`apps/engine/src/routes/projects.ts:547`) infers task status from commit
messages. There is no networking to any cloud service. This plan wires the
engine up as a real client of `apps/cloud`'s sync API.

```
D1 auth + workspace linking ──> D2 push/pull sync loop ──> D3 conflict UI
                                                       └──> D4 presence client
```

## D1 — Auth + workspace linking

### Decision
The engine authenticates to `apps/cloud` as a real Supabase-JWT user (not the
local session-token scheme it uses for the Tauri↔engine hop — that stays
as-is and is unrelated). Reuse the existing credential-storage pattern
(`apps/engine/src/keychain.ts`, macOS Keychain via `security` CLI) rather
than inventing a new secret store.

### Changes
- **`apps/engine/src/routes/cloud.ts`** (new): `POST /engine/cloud/login`
  (proxies Supabase auth, stores the JWT via `keychain.ts` under
  `credentialRef = "cloud.session"`), `GET /engine/cloud/session` (whoami),
  `POST /engine/cloud/logout`.
- **`apps/engine/src/cloudClient.ts`** (new): thin fetch wrapper around
  `apps/cloud`'s REST API, mirrors `apps/desktop/src/api.ts`'s shape
  (`request<T>`), attaches `Authorization: Bearer <jwt>`, reads
  `CLOUD_API_URL` from config (defaults unset = cloud sync disabled).
- **`integrations` table**: add `kind = 'cloud'` row per project once linked,
  storing `workspace_id` + `project_id` (the cloud-side project this local
  project is bound to) in its existing JSON config column — no schema
  migration needed, this table already models exactly this shape.
- **UI**: extend `apps/desktop/src/components/Onboarding.tsx` /
  `ConnectForm.tsx` pattern with a "Connect to PromptZone Cloud" step;
  reuses the same connect-form UX users already know from model connections.

### Tests
- login stores a JWT the keychain can read back; logout clears it;
- linking a local project writes the `integrations` row; unlinking removes it;
- engine routes reject cloud calls when no session is stored (clear error, not a crash).

## D2 — Push/pull sync loop

### Decision
Mirror `apps/cloud`'s own auto-sync contract (M4): poll
`GET /sync/projects/{id}/changes` on an interval, pull
`GET /sync/projects/{id}/graph?since=...` only when the head advances, push
local deltas via `PUT /sync/projects/{id}/graph` with `source: "pz"`. This is
the same head-check-before-pull design already proven server-side — no new
protocol to invent.

### Changes
- **`apps/engine/src/sync/loop.ts`** (new): background interval (config:
  `CLOUD_SYNC_POLL_SECONDS`, default 20s, only runs when a project has a
  `kind='cloud'` integration row), pause while offline (fetch failure →
  backoff, don't spam).
- **Local dirty tracking**: reuse `updated_at` already on local rows;
  push payload assembled from rows changed since the last successful push
  cursor (stored in `app_state`).
- **Pull applies to SQLite**: incoming graph entities upsert into the local
  tables using the same per-field-ownership contract the cloud already
  enforces server-side (cloud is the merge authority; the client applies
  whatever it resolves, doesn't need its own merge engine) — client is a
  dumb replica of cloud's merged state for `pz`/`shared` fields it doesn't
  own locally.
- **Manual "Sync now"** IPC/HTTP trigger for the git-like mental model
  (README of `apps/cloud` explicitly keeps this even with auto-sync).

### Tests
- push-then-pull round-trips a task through a second simulated client (use
  `apps/cloud`'s in-memory backend in a test harness);
- offline push queues and flushes on reconnect, no data loss;
- poll respects `has_changes: false` and skips the pull (no wasted egress).

## D3 — Conflict / field-ownership surfacing in UI

### Decision
Cloud already resolves conflicts server-side (per-field ownership, M3) — the
client doesn't re-decide anything, but users should *see* when a field is
externally owned (e.g. `assignee`/`sprint` mirrored from Jira are read-only
locally) rather than let them edit a field their edit will never win.

### Changes
- Surface `field_versions`/authority domain on task rows so the desktop UI
  can grey out or badge `pmo`-owned fields (`assignee`, `sprint`,
  `feature_tag`) when a tracker integration is active.
- Small affordance only — this is not a new merge UI, just making the
  existing server-side rule visible.

### Tests
- pmo-owned field renders read-only when a Jira/ClickUp link is configured;
  editable when it isn't.

## D4 — Presence client (optional, do last)

### Decision
Connect to `WS /ws/projects/{id}/presence` (M6) only if D1–D3 are stable;
purely cosmetic (who's-viewing avatars), not on the critical path for the
core "my desktop app's task graph now syncs to the team" value.

### Changes
- **`apps/engine/src/sync/presence.ts`** (new): WS client, forwards
  join/leave/heartbeat to the frontend over the existing SSE/WS bridge
  pattern already used for agent-run streaming.

### Tests
- presence roster updates when a second simulated client connects/disconnects.

## Open decisions to confirm before D1 starts
- **`CLOUD_API_URL` default:** ship disabled-by-default (opt-in per project)
  vs. prompting every user on first launch. Recommend opt-in — most desktop
  users today are single-player and don't need this yet.
- **Windows/Linux keychain:** `keychain.ts` is macOS-only today (shells out
  to `security`). Cloud session storage inherits this gap — either scope D1
  to macOS first or pull in a cross-platform keyring crate/lib alongside
  this work (affects timeline).
- **Conflict UI depth (D3):** read-only badges (proposed) vs. full diff view
  showing what the tracker overwrote — start minimal, expand if users ask.

## Sequencing summary
1. **D1** — keystone; nothing else works without a linked, authenticated project.
2. **D2** *(after D1)* — the actual value: local graph and cloud graph converge.
3. **D3** *(after D2)* — polish; prevents silent-loss confusion once a tracker mirror is live.
4. **D4** *(independent, last)* — collaboration nicety, not required for the sync value prop.
