# PromptConnext Cloud

**Sync + collaboration** backend for the PromptConnext task graph, plus a
workspace-BYO RAG assistant (ADR 0011). It holds the shared requirement →
spec → task → artifact → agent-run lineage so collaborators and business
stakeholders see the same truth, and answers questions grounded in that
graph. Per ADR 0011's amended posture: no *source code* at rest (v1 has none
to store), and no *end-user* credentials — a workspace admin's own model API
key is the only credential the cloud ever holds, encrypted server-side
(`app/secrets.py`), never in a Supabase row.

See [`../../docs/promptconnext-platform-architecture.md`](../../docs/promptconnext-platform-architecture.md)
and the roadmap in [`../../docs/plans/`](../../docs/plans).

[`apps/web`](../web) (M8) is a read-only browser client of this API's
sync/workspace/invitation endpoints — its origin must be added to
`CORS_ORIGINS` (default already includes `http://localhost:3000` for local
dev; production origins go in Railway, see
[`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md#28-web-app-apps-web--vercel)).

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
docker build -t promptconnext-cloud .
docker run -p 8080:8080 --env-file .env.local promptconnext-cloud
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
| GET | `/workspaces` (0 memberships) | authed → auto-provisions a personal workspace |
| PATCH | `/workspaces/{id}` | admin (name / git_config) |
| GET | `/workspaces/{id}/members` | member |
| POST | `/workspaces/{id}/invitations` | admin |
| POST | `/invitations/{token}/accept` | authed |
| DELETE | `/workspaces/{id}/members/{user_id}` | admin |

RLS policies (migration 0003) enforce the same membership rules in Postgres when
the backend forwards the caller's JWT.

**Personal-workspace auto-provision (ADR 0015 §5).** When an authenticated user
resolves to **zero** memberships on `GET /workspaces`, the cloud mints a default
`"{user}'s workspace"` with that user as admin — so the desktop membership gate
never dead-ends a brand-new account. It is idempotent (a no-op once any
membership exists, so an invited user who already accepted gets none) and reuses
the same create path migration 0007 fixed, so the new admin row satisfies
`pz_is_admin` without a bootstrap deadlock. Disable / stage the rollout with
`AUTO_PROVISION_PERSONAL_WORKSPACE=false`.

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

- **`pz`** — PromptConnext-authoritative (agent evidence, spec lineage, `status`).
- **`pmo`** — external-tracker-authoritative (`assignee`, `sprint`, `feature_tag`).
- **`shared`** — `title` / `description`, LWW acceptable.

The pure engine in `app/db/merge.py` merges field-by-field using per-field
version clocks (`field_versions`), so a `pmo` writer can never overwrite a `pz`
field and vice-versa. The sync payload carries `source: "pz" | "pmo"`.

### Jira / ClickUp mirror (M5, extended M12)

A thin, field-scoped two-way boundary — only status/assignment/linkage (and,
as of M12, comments) mirror; the AI-native graph stays in PromptConnext.

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

**Comments (M12):** `comment_created`/`comment_updated` Jira webhooks are a
different payload shape from `jira:issue_updated` — routed separately in
`tracker_webhook()` (`app/api/integrations.py`), not through
`handle_webhook()`/`InboundUpdate`. `TrackerAdapter.parse_comment_webhook()`
is deliberately *not* a required protocol method (only `JiraAdapter`
implements it; ClickUp has none) — called via `getattr(...)`, so an adapter
with no comment support simply doesn't define it. A parsed comment becomes a
`Discussion(source="pmo")` with a deterministic id
(`f"{provider}-comment-{comment_id}"`), so webhook redelivery upserts the
same row instead of duplicating it.

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
Discussions (M12) and PRs (M11) extend this list; Artifact staying
content-less is now a deliberate, permanent design decision, not an open gap
— see `app/rag/source.py`'s docstring.

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

### Graph-aware retrieval (M10)

Status/progress questions ("is X done?") are answered from an exact graph
walk, not similarity search — the moat identified in ADR 0011. Every chat
question is classified first (`app/rag/classify.py`, a cheap regex
heuristic — deterministic and free, no model round-trip; see the module
docstring for the full justification):

- **lineage** — resolved against the project graph
  (`app/rag/lineage.py`: `resolve_target` matches the question to a
  requirement or task by title-token overlap, `compute_facts` walks
  requirement → specs → tasks → artifacts/agent-runs) — **no embeddings, no
  vector search**. The result (`LineageFacts`) is sent as its own SSE
  `event: facts`, ahead of the model's narration, so the exact numbers don't
  depend on parsing model output.
- **content** — the existing M9 vector-search path, unchanged.
- **mixed** — both; facts and vector chunks are concatenated into one
  context block for the model to narrate.

`Citation.source` distinguishes `"graph"` (a whole-node reference from a
graph walk) from `"vector"` (an embedded chunk, M9's original citation
shape). Retrieval stays keyed off `RAG_NODE_TYPES` (`app/rag/source.py`), so
a future entity (e.g. Discussions, M12) is additive, not a rework.

**Eval harness:** `tests/test_rag_eval.py` — a golden-question set (lineage,
content, cross-artifact, permission-boundary) over one seeded fixture
project, marked `@pytest.mark.eval` for a discoverable subset:
```bash
pytest -m eval -q
```
It's also part of the normal `pytest -q` run — no separate CI wiring needed.

### Git-host integration (M11)

PRs and code, without storing source code at rest (ADR 0011's "no source code
→ no source code *at rest*" amendment). One GitHub App is shared across all
workspaces — server-env credentials (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`), same posture as
`JIRA_API_TOKEN`. No installation access token is ever stored: one is minted
on demand (`app/integrations/github.py`, RS256 App JWT → GitHub's
installation-token endpoint) per use and discarded.

| Method | Path | Guard |
|---|---|---|
| POST | `/workspaces/{id}/integrations/github/install` | admin — non-secret config (`installation_id`, `repo`, `default_branch`, `project_id`) |
| POST | `/api/webhooks/github` | public, HMAC-signature-verified (`X-Hub-Signature-256`) |

v1 is one-repo-per-workspace; the admin completes the App install on
GitHub's own site first (external, one-time — no OAuth redirect handling
lives in this repo, same posture as generating a Jira API token today) and
supplies the resulting `installation_id`.

**PRs** are a different data class from code — ADR 0011 explicitly names PR
title/description as an indexable v2 source, not source code. A
`pull_request` webhook (opened/merged) resolves task linkage via the same
T-ref commit convention `apps/engine`'s `syncTasksFromGit` already uses
(`\bT\d{3}\b` matched against a task's `feature_tag`); a match creates a real
`Artifact` (`kind="pr"`, so it shows up in the existing graph) and enqueues
the PR text through the same M9 embed pipeline (`RAG_NODE_TYPES` gained
`"pull_requests"`). A PR with no matching task is skipped entirely, mirroring
`syncTasksFromGit`'s own behavior. `RAG_NODE_TYPES` staying extensible (M10's
design) is why this only required an additive `node_text()` branch.

**Code** gets its own table (`pz_code_chunks`) with **no `content` column, by
construction** — only `(repo, path, sha, start_line, end_line, embedding)`.
A `push` webhook to the default branch enqueues one job per changed file onto
the same off-request-path queue M9 already uses for embeddings (fetching a
file is exactly the kind of external call that must never block a webhook
response); the worker fetches the file, chunks it by line
(`app/rag/code_chunker.py` — line ranges, not `app/rag/chunker.py`'s word
count, since citations need to link to an exact location), embeds each
chunk, and stores only the reference + embedding. The fetched text is a
local variable that goes out of scope at the end of that one function —
never passed to any repository write. Removed files get their chunks
deleted directly (no fetch needed).

At answer time, a content/mixed chat question also runs
`code_vector_search` (same query embedding, no separate per-workspace code
model in v1). For each hit, `app/api/assistant.py::_fetch_code_context`
mints a fresh installation token and re-fetches just that line range from
GitHub — used to build the model's context for that one request, then
discarded. `Citation.source` gains `"code"`, with `repo`/`path`/
`start_line`/`end_line` so the web UI can link straight to the Git host
(`https://github.com/{repo}/blob/{sha}/{path}#L{start}-L{end}`).

`tests/test_github_storage_posture.py` is the automated proof of "no source
code at rest": it runs a full index + chat cycle against a fake Git-host
client returning distinctive fake source text, then deep-scans every string
reachable from the repository's own state and asserts that text is nowhere
in it — not just that today's schema lacks a `content` column, but that
nothing in the actual data flow ever writes one.

### Discussions (M12)

Comments threaded on any graph node (`parent_node_type`/`parent_node_id`) —
a `GraphEntity` like every other synced type (`discussions` in
`ENTITY_TYPES`), so it rides the *existing* sync/pull/tombstone/RLS
machinery unmodified, not a bespoke pipeline.

| Method | Path | Guard |
|---|---|---|
| POST | `/projects/{id}/discussions` | member — the one deliberate exception to "authoring stays on desktop" (M8); comments are collaboration data, not planning artifacts |

Reads aren't a new endpoint — discussions come back on the existing
`GET /sync/projects/{id}/graph` (`ProjectGraph.discussions`), and desktop
authors them through the same `PUT .../graph` push every other entity uses.

**Field authority:** unlike `Task` (row-level split: `status` is pz-only,
`assignee` is pmo-only), `FIELD_AUTHORITY["discussions"]` is `"shared"` for
both `body` and `author` — a pz-native comment and a pmo-mirrored (Jira)
comment are always *different rows*, never the same row edited by both
sides, so `"shared"` (either source may write, LWW) is correct; a `"pz"`/
`"pmo"` split would make the merge silently drop pmo's writes, which would
make comment mirroring impossible rather than merely lower-priority.

**RAG opt-in:** pz-native discussions embed by default (same
`RAG_NODE_TYPES`/`node_text()` pipeline as every other source); pmo-mirrored
ones don't, unless the workspace sets `rag_index_pmo_discussions` (via
`PATCH /workspaces/{id}`) — third-party content defaults out (ADR 0011). The
gate lives in `app/rag/queue.py::_process_job`, checked per-job right before
the embedding call, not at ingest time — so flipping the setting takes
effect on the next (re-)embed, not retroactively on already-embedded rows.

**Desktop sync:** `apps/engine` gained its *first* pull-from-cloud
capability for this — sync was push-only before M12. It's scoped narrowly to
discussions only (`pullProjectDiscussions()` in `apps/engine/src/sync/loop.ts`,
reading the existing incremental `GET .../graph?since=` endpoint and only
looking at its `discussions` array) — engine remains the sole source of
truth for requirements/specs/tasks/artifacts/agent_runs, unchanged.

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
| `0010_github.sql` | `pz_pull_requests`, `pz_code_chunks` (no `content` column), `pz_code_match_chunks` RPC (M11) |
| `0011_discussions.sql` | `pz_discussions` (comments, RLS), `pz_workspaces.rag_index_pmo_discussions` (M12) |

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
