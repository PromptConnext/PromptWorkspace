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
# apply the schema:
psql "$SUPABASE_DB_URL" -f migrations/0001_init.sql   # or paste into the SQL editor
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
Supabase Auth + Row Level Security land in the next milestone.

## What's intentionally not here yet

Auth/RLS, WebSocket presence, Jira/ClickUp mirror, and per-field conflict
resolution (current policy: last-write-wins by server `updated_at`).
