# PromptZone Cloud

Thin **sync + collaboration** backend for the PromptZone task graph. It holds the
shared requirement → spec → task → artifact → agent-run lineage so collaborators
and business stakeholders see the same truth. It does **not** run models, store
credentials, or hold source code — those stay on the user's machine.

See [`../../docs/promptzone-platform-architecture.md`](../../docs/promptzone-platform-architecture.md)
and the roadmap in [`../../docs/plans/`](../../docs/plans).

## Stack

FastAPI (Python) · Supabase/Postgres. A `memory` data backend lets the service
run and be tested with **no external dependencies**.

## Quick start

```bash
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# In-memory backend, stub auth — no Supabase needed:
uvicorn app.main:app --reload --port 8080
# open http://localhost:8080/docs
```

### Run against Supabase

```bash
cp .env.example .env.local
# set DATA_BACKEND=supabase, SUPABASE_URL, SUPABASE_KEY
# for real auth: AUTH_MODE=supabase, SUPABASE_JWT_SECRET
# apply the schema, in order:
for f in migrations/000*.sql; do psql "$SUPABASE_DB_URL" -f "$f"; done
uvicorn app.main:app --reload --port 8080 --env-file=.env.local
```

## Tests

```bash
pytest -q
```

## Deploy (container / Cloud Run)

```bash
docker build -t promptzone-cloud .
docker run -p 8080:8080 --env-file .env.local promptzone-cloud
```

Cloud Run reads `$PORT` automatically. **Run a single instance** for now:
presence, rate-limit, and metrics state are in-process (see [Scaling](#scaling)).
For presence, enable session affinity so a client's WebSocket sticks to one
instance.

## Features & API

Identity: **stub** mode uses an `X-User-Id` header (dev/test); **supabase** mode
verifies a real HS256 bearer JWT (`AUTH_MODE=supabase` + `SUPABASE_JWT_SECRET`).

### Workspaces, membership & invitations (M2)

Access control tier: a workspace owns projects and carries the shared **non-secret**
Git metadata. Access is by membership, not project ownership.

| Method | Path | Guard |
|---|---|---|
| POST | `/workspaces` | authed (becomes admin) |
| GET | `/workspaces` · `/workspaces/{id}` | member |
| PATCH | `/workspaces/{id}` | admin (name / git_config) |
| GET | `/workspaces/{id}/members` | member |
| POST | `/workspaces/{id}/invitations` | admin |
| POST | `/invitations/{token}/accept` | authed |
| DELETE | `/workspaces/{id}/members/{user_id}` | admin |

RLS policies (migration 0003) enforce the same membership rules in Postgres when
the backend forwards the caller's JWT.

### Projects & sync

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | create (needs `workspace_id`) |
| GET | `/projects` · `/projects/{id}` | list / fetch (member-scoped) |
| PUT | `/sync/projects/{id}/graph` | push a graph delta (upsert) |
| GET | `/sync/projects/{id}/graph` | pull graph — `since`, `limit`, `after_ts`, `after_id` |
| GET | `/sync/projects/{id}/changes` | cheap head: `{cursor, counts, has_changes}` |

**Deletes** are tombstones: a delete is an upsert that sets `deleted_at`.
Bootstrap pulls (no `since`) hide tombstones; incremental pulls (`since` set)
include them so peers learn of deletions. A background loop GCs tombstones older
than `TOMBSTONE_TTL_DAYS`.

**Auto-sync (M4):** poll `/changes` to decide whether to pull (`has_changes`),
then pull only when the head advances. Large projects paginate via `limit` +
keyset (`after_ts`,`after_id`); the response carries `next_id` / `has_more`.

### Conflict resolution — per-field ownership (M3)

Instead of row-level last-write-wins (which silently drops concurrent edits),
each field has an **authority domain**:

- **`pz`** — PromptZone-authoritative (agent evidence, spec lineage, `status`).
- **`pmo`** — external-tracker-authoritative (`assignee`, `sprint`, `feature_tag`).
- **`shared`** — `title` / `description`, LWW acceptable.

The pure engine in `app/db/merge.py` merges field-by-field using per-field
version clocks (`field_versions`), so a `pmo` writer can never overwrite a `pz`
field and vice-versa. The sync payload carries `source: "pz" | "pmo"`.

### Jira / ClickUp mirror (M5)

A thin, field-scoped two-way boundary — only status/assignment/linkage mirror;
the AI-native graph stays in PromptZone.

| Method | Path | Guard |
|---|---|---|
| POST | `/workspaces/{id}/integrations/{provider}` | admin (configure) |
| POST | `/projects/{id}/tasks/{task_id}/mirror` | member (push one task out) |
| POST | `/api/webhooks/{provider}` | public, HMAC-signature-verified |

Inbound webhooks write with `source="pmo"`, so M3's merge lets them touch only
pmo fields. Tracker **credentials never live in the DB** — the API token and
webhook secret come from the server env; only non-secret settings (base URL,
project key, status map) sit on the workspace. `base_url` is allowlisted to the
provider's domain over HTTPS to prevent credential exfiltration.

### Presence (M6)

`WS /ws/projects/{id}/presence` — authenticated (JWT or `?user_id=` in stub
mode), membership-gated, ephemeral who's-here roster fanned out on
join/leave/heartbeat. No graph data flows over WebSocket; presence is never
persisted.

### Observability (M7)

`/health` reports `backend`, `schema_version` (latest bundled migration), and
in-process `metrics` (pushed/pulled/merged/conflicts). Sync pushes log
structured lines with `project`, `user`, `source`, and counts.

## Scaling

State that is **in-process today** (single instance): presence rooms,
rate-limit buckets, `/health` metrics. Horizontal scale needs a shared
backplane (Redis pub/sub or a managed realtime service) before running >1
instance. The task graph itself is in Postgres and scales normally.

## Migrations

Apply in order; each is additive and backward-compatible:

| File | Adds |
|---|---|
| `0001_init.sql` | task-graph tables |
| `0002_soft_delete.sql` | `deleted_at` tombstones + partial indexes |
| `0003_auth_workspaces.sql` | workspaces, membership, invitations, RLS + backfill |
| `0004_field_ownership.sql` | `field_versions`, task `assignee`/`sprint` |
| `0005_tracker_links.sql` | `pz_task_links`, workspace `integration_config` |

A later cleanup migration flips `projects.workspace_id` to `NOT NULL` and drops
the legacy `owner_id` once the M2 cutover (RLS + `AUTH_MODE=supabase`) is done.
