# PromptZone Cloud

Thin **sync + collaboration** backend for the PromptZone task graph. It holds the
shared requirement → spec → task → artifact → agent-run lineage so collaborators
and business stakeholders see the same truth. It does **not** run models, store
credentials, or hold source code — those stay on the user's machine.

See [`../../docs/promptzone-platform-architecture.md`](../../docs/promptzone-platform-architecture.md).

## Stack

FastAPI (Python) · Supabase/Postgres. A `memory` data backend lets the service
run and be tested with **no external dependencies**.

## Quick start

```bash
cd apps/cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Runs with the in-memory backend out of the box (no Supabase needed):
uvicorn app.main:app --reload --port 8080
# open http://localhost:8080/docs
```

### Run against Supabase

```bash
cp .env.example .env.local
# set DATA_BACKEND=supabase, SUPABASE_URL, SUPABASE_KEY
# apply the schema, in order:
psql "$SUPABASE_DB_URL" -f migrations/0001_init.sql          # or paste into the SQL editor
psql "$SUPABASE_DB_URL" -f migrations/0002_soft_delete.sql
uvicorn app.main:app --reload --port 8080 --env-file=.env.local
```

## Tests

```bash
pytest -q
```

## API (this milestone)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + active backend |
| POST | `/projects` | create a project |
| GET | `/projects` | list caller's projects |
| GET | `/projects/{id}` | fetch a project |
| PUT | `/sync/projects/{id}/graph` | push a graph delta (upsert) |
| GET | `/sync/projects/{id}/graph?since=` | pull graph (incremental when `since` set) |

Identity is stubbed: send an `X-User-Id` header to act as a given user. Real
Supabase Auth + Row Level Security land in a later milestone.

## Deletes (tombstones)

Every graph entity (`requirements`, `spec_documents`, `tasks`, `artifacts`,
`agent_runs`) carries a nullable `deleted_at`. There is no separate delete
endpoint — **a delete is just an upsert that sets `deleted_at`**, pushed
through the existing `PUT /sync/projects/{id}/graph` path. Pull semantics
differ by mode:

- **Bootstrap pull** (`GET .../graph` with no `since`) returns **live rows
  only** — a fresh client never sees long-dead tombstones.
- **Incremental pull** (`GET .../graph?since=<cursor>`) returns everything
  changed after the cursor **including tombstones**, so peers learn of the
  deletion and can remove the row locally.

Re-creating an id after deletion is a normal upsert that omits/clears
`deleted_at`; last-write-wins by `updated_at` decides the winner as usual.

### Tombstone GC

A background loop purges tombstones older than `TOMBSTONE_TTL_DAYS` (default
30) every `TOMBSTONE_GC_INTERVAL_SECONDS` (default 3600). This is safe once
every client has had a chance to pull past a given tombstone. Set
`TOMBSTONE_TTL_DAYS=0` to disable the loop. GC never touches live rows.

## What's intentionally not here yet

Auth/RLS, WebSocket presence, Jira/ClickUp mirror, and per-field conflict
resolution (current policy: last-write-wins by server `updated_at`). See
`../../docs/plans/0001-cloud-deletes-and-auth.md` and
`../../docs/plans/0002-cloud-conflict-sync-integrations.md` for the full
roadmap.
