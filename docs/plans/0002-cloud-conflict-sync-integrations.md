# Plan — apps/cloud: conflict ownership, auto-sync, integrations, presence, ops

**Date:** 2026-07-05 · **Status:** Proposed · **Scope:** `apps/cloud` (+ engine touchpoints)
**Extends:** ADR 0010 (sync model) · **Follows:** plan `0001-cloud-deletes-and-auth.md` (M1 deletes, M2 auth/workspaces)
**Depth:** implementation-ready · Milestones **M3–M7**.

This continues the roadmap after deletes and auth land. Ordering is dependency-driven: **M3 is the keystone** — ADR 0010 §4 requires per-field ownership *before* auto-sync, and the Jira/ClickUp mirror needs the same field-ownership split to know which side wins each field.

```
M3 per-field ownership ──┬──> M4 auto-sync
                         └──> M5 Jira/ClickUp mirror
M6 presence          (independent)
M7 ops hardening     (continuous; slot in opportunistically)
```

Baseline assumed after plan 0001: `deleted_at` tombstones exist; identity is real Supabase JWT; projects are workspace-scoped with membership + RLS.

---

## M3 — Per-field conflict ownership (keystone)

### Problem
LWW by `updated_at` (ADR 0010 §4) silently drops concurrent edits and can't coexist with an external tracker: if Jira owns `assignee` and PromptZone owns `status`, a whole-row overwrite corrupts one of them. ADR 0010 mandates fixing this before auto-sync.

### Decision
Move from **row-level LWW** to **field-level merge with declared ownership**. Each entity field belongs to an *authority domain*:
- **`pz`** (PromptZone-authoritative, AI-native): agent-runs, artifacts, spec traceability, `acceptance_criteria`, `status` transitions driven by agent evidence.
- **`pmo`** (external-tracker-authoritative): `assignee`, `sprint`, `feature_tag`, human-set priority.
- **`shared`** (LWW still acceptable): `title`, `description` — free-text with low contention.

On upsert, the server merges incoming fields into the stored row **per field**, applying LWW *within a domain* but never letting a `pmo` writer overwrite a `pz` field or vice-versa. This requires per-field timestamps, not one row `updated_at`.

### Changes

**1. Field metadata — `app/models/schemas.py`**
Declare ownership once, as a class-level map per entity, plus a shared merge helper:
```python
FIELD_AUTHORITY: dict[str, dict[str, str]] = {
    "tasks": {
        "title": "shared", "description": "shared",
        "status": "pz", "acceptance_criteria": "pz",
        "assignee": "pmo", "sprint": "pmo", "feature_tag": "pmo",
    },
    # requirements / spec_documents / artifacts / agent_runs: mostly "pz"
}
```
Add `assignee: str | None` and `sprint: str | None` to `Task` (new PMO fields the mirror will populate).

**2. Per-field versioning — new column `field_versions jsonb`**
`migrations/0004_field_ownership.sql`:
```sql
-- Map of field_name -> {updated_at, source} for conflict-safe merges.
alter table pz_tasks          add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_requirements   add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_spec_documents add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_artifacts      add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_agent_runs     add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_tasks          add column if not exists assignee text;
alter table pz_tasks          add column if not exists sprint   text;
```

**3. Merge engine — `app/db/merge.py`** (new)
Pure function, unit-testable in isolation:
```python
def merge_entity(stored: dict, incoming: dict, authority: dict[str, str],
                 source: str, now: datetime) -> dict:
    """Field-by-field merge. `source` is 'pz' or 'pmo'.
    A field is written only if source is allowed to own it AND the incoming
    per-field timestamp is newer than the stored one (LWW within a domain)."""
```
Rules: reject a write to a field whose authority domain ≠ `source` (unless `shared`); within an allowed field, apply LWW using `field_versions[field].updated_at`. Returns merged row + updated `field_versions`.

**4. Wire into both repos**
`upsert_graph` calls `merge_entity` against the stored row instead of blind overwrite. The sync payload gains an optional `source` (default `"pz"`; the Jira webhook path sends `"pmo"`). Cursor (`updated_at`) becomes `max` of touched field timestamps.

**5. Sync API — `app/api/sync.py`**
`GraphUpsertRequest` gains `source: Literal["pz","pmo"] = "pz"`. Response unchanged. No new endpoint.

### Tests — `tests/test_merge.py` (new) + `tests/test_sync.py`
- pz write cannot clobber a pmo field and vice-versa;
- concurrent edits to *different* fields both survive (the case LWW dropped);
- same-field concurrent edit within a domain → newer wins;
- `shared` field falls back to LWW;
- migration backfill: existing rows get an empty `field_versions` and behave as LWW until first field-scoped write.

### Consequences
Retires the one data-loss risk ADR 0010 flagged. Unblocks M4 and M5. Slightly larger write path; keep `merge.py` pure so it's cheap to test and reason about.

---

## M4 — Automatic background sync

**Depends on M3.** ADR 0010 §3 defers auto-sync until conflicts are safe — M3 satisfies that.

### Decision
Replace the manual-only trigger with **debounced push + periodic pull**, still offline-first. This is mostly **engine-side** (the desktop app) with thin cloud support.

### Changes
- **Cloud (`apps/cloud`):**
  - Add `GET /sync/projects/{id}/changes?since=` returning a lightweight `{cursor, counts}` head so the engine can cheaply detect "is there anything to pull" before a full pull.
  - Add optional `If-None-Match`/cursor short-circuit: return `304`-style empty when `since == head`.
  - Rate-limit sync endpoints per user/workspace (see M7) to protect against a chatty client.
- **Engine (desktop, `apps/*` engine — coordinate, do not implement blind):**
  - Debounced push: coalesce local graph mutations, flush ~2–5 s after quiescence or on N pending changes.
  - Periodic pull: poll `/changes` every ~15–30 s (configurable, backoff on error); full pull only when head advances.
  - Offline queue: deltas persist locally and flush on reconnect (already the ADR 0010 §6 posture).
  - Surface sync state (synced / syncing / offline / conflict) in the UI.

### Tests
- Cloud: `/changes` head correctness, empty-since fast path, rate-limit returns 429.
- Engine: debounce coalescing, backoff on failure, offline→online flush (engine test suite).

### Note
Because M3 makes merges safe, auto-sync no longer risks silent loss — but keep the manual "Sync now" affordance for the Git-like mental model users learned in v1.

---

## M5 — Jira / ClickUp two-way mirror

**Depends on M3.** Phase 2 roadmap item ("one enterprise sync"). The field-ownership split from M3 decides direction per field: PromptZone pushes `pz` fields *out*, the tracker pushes `pmo` fields *in*.

### Decision
A **thin sync boundary**, not deep integration. Mirror only status/assignment/linkage — the AI-native execution graph stays in PromptZone (nothing external can hold it). Start with **Jira** (roadmap names it explicitly); ClickUp is a second adapter behind the same interface.

### Changes
- **Adapter interface — `app/integrations/tracker.py`** (new): `push_task(task) -> external_ref`, `handle_webhook(payload) -> list[GraphUpsertRequest]` with `source="pmo"`, `link(task_id, external_key)`.
- **Jira adapter — `app/integrations/jira.py`**: outbound REST (create/transition issue, mirror `status`↔Jira status via a status map); inbound webhook `POST /api/webhooks/jira` → translate issue-updated into a `pmo`-sourced upsert (assignee, sprint, status). Reuse M3's merge so inbound writes only touch `pmo` fields.
- **Mapping storage — `migrations/0005_tracker_links.sql`**: `pz_task_links (task_id, provider, external_key, external_url, updated_at)`; workspace-level tracker config (base URL, project key, status map) in `pz_workspaces.integration_config jsonb`.
- **Credentials:** same rule as plan 0001's Git-credential decision — **no raw tokens in plaintext**. Use Jira OAuth app / Connect install or encrypted-at-rest secret; store only a reference.
- **Endpoints:** `POST /workspaces/{id}/integrations/jira` (admin, configure), `POST /api/webhooks/jira` (public, signature-verified), `POST /projects/{id}/tasks/{task_id}/mirror` (push one task).

### Tests
- outbound: task create maps fields correctly; status transition sends the right Jira transition;
- inbound: webhook updates only `pmo` fields, `pz` fields untouched (proves the M3 boundary);
- signature verification rejects forged webhooks;
- ClickUp adapter conformance against the same interface (later).

### Consequences
Delivers the enterprise-fit promise while preserving the moat. Two-way but field-scoped, so no tug-of-war on any single field.

---

## M6 — Real-time presence (WebSocket)

**Independent** of M3–M5; pure collaboration polish. Last remaining "not here yet" item.

### Decision
Add ephemeral presence — who's viewing/editing a project — over WebSocket. **No graph data flows over WS**; it stays sync-based. Presence is in-memory only (never persisted).

### Changes
- **`app/api/presence.py`** (new): `WS /ws/projects/{id}/presence`. On connect, authenticate the JWT (query param or subprotocol), verify workspace membership, join a room keyed by project id. Broadcast join/leave and heartbeat `{user_id, cursor_hint, last_seen}`.
- **Connection manager — `app/ws/manager.py`** (new): per-project set of sockets; fan-out; prune on disconnect/timeout. Single-process for v1; note that horizontal scale needs a Redis/pub-sub backplane (defer, flag).
- **Config:** `WS_HEARTBEAT_SECONDS` (default 20), `WS_MAX_CONNECTIONS_PER_PROJECT`.

### Tests
- unauthorized socket rejected; non-member rejected;
- two clients see each other's join/leave;
- idle prune after missed heartbeats.

### Note
Deploy target must support sticky WS (Cloud Run: enable session affinity, or move presence to a managed realtime service). Multi-instance fan-out is out of scope for v1 — single instance or Supabase Realtime as an alternative.

---

## M7 — Ops hardening (continuous)

Small, independent items; land opportunistically alongside the above.

- **Tombstone GC** (deferred from M1): scheduled purge of `deleted_at < now() - TOMBSTONE_TTL_DAYS` (default 30). Safe once all clients have synced past them; expose the TTL in config. Implement as a periodic task or a SQL cron.
- **Pull pagination:** `GET /sync/.../graph` currently returns the full graph. Add `limit` + keyset pagination on `(updated_at, id)` for large projects; keep unpaginated default for small ones.
- **Rate limiting:** per-user/workspace limits on sync + webhook endpoints (needed by M4/M5). Reuse a simple token bucket in the repo layer or a middleware; return 429.
- **Schema cleanup:** the migration that makes `projects.workspace_id NOT NULL` and drops legacy `owner_id` (queued from plan 0001 rollout step 4).
- **Observability:** structured request logging with `workspace_id`/`project_id`, sync counters (pushed/pulled/merged/conflicts), and a `/health` extension reporting backend + migration version.

### Tests
- GC removes only expired tombstones, never live rows or unsynced-recent tombstones;
- pagination returns stable, complete pages under concurrent writes;
- rate limiter returns 429 past threshold and recovers.

---

## Sequencing summary
1. **M3 per-field ownership** — keystone; retires the LWW data-loss risk; unblocks M4 + M5.
2. **M4 auto-sync** *(after M3)* and **M5 Jira/ClickUp mirror** *(after M3)* — parallelizable once M3 lands.
3. **M6 presence** — independent; schedule when collaboration UX is prioritized.
4. **M7 ops** — continuous; fold GC/pagination/rate-limits in as M4/M5 create the need.

## Open decisions to confirm
- **Status mapping** PromptZone↔Jira/ClickUp (which local `TaskStatus` maps to which external status) — needs product sign-off before M5.
- **Presence transport:** in-app WebSocket vs. Supabase Realtime (affects Cloud Run scaling) — decide before M6.
- **`shared`-field policy:** keep LWW for `title`/`description`, or make them `pz` too? Affects M3 field map.
- Tombstone TTL and auto-sync poll/debounce intervals — tune with real usage.
