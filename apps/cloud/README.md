# PromptZone Cloud

**Sync + collaboration** backend for the PromptZone task graph, plus a
workspace-BYO RAG assistant (ADR 0011). It holds the shared requirement →
spec → task → artifact → agent-run lineage so collaborators and business
stakeholders see the same truth, and answers questions grounded in that
graph. Per ADR 0011's amended posture: no *source code* at rest (v1 has none
to store), and no *end-user* credentials — a workspace admin's own model API
key is the only credential the cloud ever holds, encrypted server-side
(`app/secrets.py`), never in a Supabase row.

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
verifies a real bearer JWT (`AUTH_MODE=supabase`) — via JWKS at `SUPABASE_URL`
(current default; covers the asymmetric ES256/RS256 tokens Supabase Auth now
issues) or, as a legacy fallback, HS256 with `SUPABASE_JWT_SECRET`.

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

### RAG assistant v1 (M9)

Chat grounded in synced project artifacts, with citations, powered by a
**workspace-connected BYO model** (ADR 0011). v1 sources: `requirements`,
`spec_documents`, `tasks` — the entities that already carry free text.
Discussions and Artifact/code content aren't sources yet (no such entity/field
exists); adding them is a later milestone, not silently expanded here.

| Method | Path | Guard |
|---|---|---|
| POST | `/workspaces/{id}/model-connection` | admin — configure chat + embed model, BYO key |
| POST | `/projects/{id}/assistant/chat` | member — SSE-streamed answer + `citations` |
| POST | `/projects/{id}/assistant/reindex` | admin — backfill embeddings for an existing project |

**Embed-on-ingest:** every `PUT /sync/projects/{id}/graph` push enqueues its
requirement/spec/task ids onto an in-process queue; a background worker
(`app/rag/queue.py`) chunks (~500 words, 50-word overlap) and embeds off the
request path — an upsert never blocks on a model call. A tombstoned or
missing node has its chunks deleted immediately by the same worker, and again
by the tombstone GC loop when the row is hard-deleted (belt-and-suspenders on
the same M1 GC pass).

**Secrets:** the workspace admin's model API key is never stored in
plaintext. `app/secrets.py` encrypts it (Fernet, key = `RAG_KEY_ENCRYPTION_KEY`
env var — never written to Supabase) into an opaque `secret_ref`; only that
ciphertext lands in `pz_workspace_model_connections`. `data_backend=memory`
falls back to a dependency-free dev store (fine — nothing persists past the
process anyway).

**Retrieval scoping:** membership-scoped *before* similarity (ADR 0011) —
`vector_search` filters by `(workspace_id, project_id)` as an explicit
predicate ahead of the nearest-neighbour search, on top of the RLS policy on
`pz_rag_chunks` and the app-layer membership guard on the chat route. A member
of one workspace cannot retrieve another workspace's chunks even given its
project id.

**Cost controls:** `app/rag/budget.py` tracks a per-workspace, per-day token
usage counter (`daily_token_budget`, admin-set on the model connection);
exceeding it 429s. Same in-process, single-instance shape as the rate limiter
below — inherits its Redis-backplane TODO rather than adding a second one.

**Providers:** one OpenAI-compatible HTTP client (`/embeddings`,
`/chat/completions` with `stream=true`) driven by the connection's `base_url`
— works for OpenAI, Azure OpenAI, Ollama, and most self-hosted gateways
without a per-provider SDK. `embed_dim` is fixed at 1536 for v1 (the pgvector
column width); a workspace's `embed_model` must produce 1536-dim vectors.

**Prompt-injection posture:** retrieved chunk text is passed to the model as
data inside a `CONTEXT:` block, with a system prompt instructing it to ignore
any instructions found there. No tool use in v1 — the assistant is read-only
by construction.

## Scaling

State that is **in-process today** (single instance): presence rooms,
rate-limit buckets, `/health` metrics, the RAG embed queue, and the daily
token budget. Horizontal scale needs a shared backplane (Redis pub/sub or a
managed realtime service) before running >1 instance. The task graph itself
is in Postgres and scales normally.

## Migrations

Apply in order; each is additive and backward-compatible:

| File | Adds |
|---|---|
| `0001_init.sql` | task-graph tables |
| `0002_soft_delete.sql` | `deleted_at` tombstones + partial indexes |
| `0003_auth_workspaces.sql` | workspaces, membership, invitations, RLS + backfill |
| `0004_field_ownership.sql` | `field_versions`, task `assignee`/`sprint` |
| `0005_tracker_links.sql` | `pz_task_links`, workspace `integration_config` |
| `0006_grants.sql` | base table `GRANT`s to `authenticated` (RLS alone doesn't grant access — see below) |
| `0007_membership_bootstrap.sql` | fixes a bootstrap deadlock in the membership RLS policy |
| `0008_invitations_rls.sql` | enables RLS on `pz_invitations` (previously missing entirely) + invite-acceptance RLS fix |
| `0009_rag.sql` | `pgvector` extension, `pz_workspace_model_connections`, `pz_rag_chunks`, `pz_rag_match_chunks` RPC (M9) |

**0006–0008 were found by actually running `apps/cloud` against a real local
Supabase instance** (`supabase start` + these migrations + `AUTH_MODE=supabase`
against a real signed-up user) instead of only the in-memory backend the test
suite uses. Each is a genuine bug that was invisible until then:
- **No base grants (0006):** RLS policies exist, but Postgres checks the
  table-level `GRANT` *before* RLS ever runs — hosted Supabase projects grant
  this schema-wide automatically at project creation, so it's easy to never
  notice a fresh project's own migrations never did it themselves.
- **Membership bootstrap deadlock (0007):** the very first admin membership
  row for a new workspace could never satisfy `pz_is_admin(workspace_id)` —
  no admin exists yet to satisfy it. Workspace creation was unreachable under
  real RLS. This was masked because `for_user()` (which forwards the caller's
  JWT so RLS applies) was previously dead code, never called from any route.
- **`pz_invitations` had no RLS at all (0008):** any authenticated user could
  read or modify any workspace's invitations once 0006's grants made the
  table reachable.

A later cleanup migration flips `projects.workspace_id` to `NOT NULL` and drops
the legacy `owner_id` once the M2 cutover (RLS + `AUTH_MODE=supabase`) is done.
