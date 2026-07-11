# Plan — Cloud workspace & RAG project assistant

**Date:** 2026-07-11 · **Status:** Proposed · **Scope:** `apps/cloud` + new `apps/web`
**Implements:** ADR 0011 · **Follows:** plan `0002-cloud-conflict-sync-integrations.md` (M3–M7)
**Depth:** milestone-level (implementation detail to be specced per milestone) · Milestones **M8–M11**.

Ordering is value-driven with a deliberate de-risk gate: M8+M9 ship the pillar on data the cloud *already holds* (zero change to the storage posture); M11 — the only milestone that touches code/PRs and Git-host secrets — is gated on M9 earning real usage.

```
M8 web workspace ──────┬──> M9 RAG v1 (artifacts) ──> M10 hybrid retrieval ──> M11 Git-host (PRs + code)
                       │                                                          ▲ gate: M9 usage
M7 ops hardening (continuous — backplane pressure rises from M9)
```

---

## M8 — Collaborative web workspace (`apps/web`)

### Goal
Stakeholders join a workspace in a browser and see the same truth as the desktop app: projects, the requirement → spec → task → artifact → agent-run graph, and progress — read-first.

### Shape
- **New app** `apps/web`: Next.js (App Router) + Supabase Auth on the client, calling the existing `apps/cloud` API with the user's JWT (`AUTH_MODE=supabase` already verifies it). No new backend for reads — the sync/graph endpoints already exist and are membership-scoped.
- Deploy on Vercel (static/SSR web app has none of the WebSocket/single-instance constraints that ruled Vercel out for `apps/cloud` — see `DEPLOYMENT.md` §2.5). Add its origin to `CORS_ORIGINS`.
- Views: workspace switcher · project list · graph/lineage browser · task board with per-field authority surfaced (`pz` vs `pmo`, from M3) · progress roll-ups per requirement.
- Invitations flow already exists (`POST /workspaces/{id}/invitations`, accept-by-token) — the web app is its natural UI.
- Presence (M6) piggybacks: show who's viewing a project.

### Out of scope
Authoring/editing (stays desktop), the assistant (M9).

### Exit criteria
A member with no desktop install signs in, accepts an invitation, browses a live project graph, and sees task progress that matches the desktop view.

---

## M9 — RAG assistant v1: grounded in synced artifacts

### Goal
Chat that answers from requirements, PRDs/specs, architecture docs, tasks, and discussions — with citations to graph nodes — powered by a **workspace-connected BYO model**.

### Data & pipeline
- **Migration:** enable `pgvector`; new tables `rag_chunks (id, workspace_id, project_id, node_type, node_id, chunk_index, content, embedding vector, updated_at)` and `workspace_model_connections (workspace_id, provider, model, embed_model, secret_ref)` — `secret_ref` points into the server secret store; **no key material in Postgres**.
- **Embed-on-ingest:** hook the existing sync upsert path — enqueue (node_id, revision) onto an in-process async queue; a background worker chunks (per-artifact-section, ~500 tokens, overlap) and embeds. **Never block an upsert on an embedding call.** Tombstoned nodes delete their chunks in the same GC loop as M1 tombstones.
- **Backfill:** admin-triggered per-project reindex for pre-existing graphs.

### Retrieval & chat
- `POST /projects/{id}/assistant/chat` (SSE streaming, same auth/rate-limit stack as sync). Pipeline: membership check → vector search **pre-filtered** by `workspace_id`/`project_id` (RLS + explicit predicate) → assemble context with node metadata → workspace model → stream answer + `citations: [{node_type, node_id, chunk_index}]` the web UI renders as links into the M8 graph browser.
- **Prompt-injection posture:** retrieved artifact text is data, not instructions — system prompt hardening + no tool use in v1; the assistant is read-only by construction.
- **Cost controls:** per-workspace daily token budget (admin-set), reuse the M4 token-bucket rate limiter per identity.

### Workspace model connection
Admin UI (web) → `POST /workspaces/{id}/model-connection`: provider + key, validated with a live health-check call (mirrors the desktop onboarding gate), key written to the secret store. Chat + embedding both bill to this key — BYO at team level, per ADR 0011.

### Exit criteria
A business member asks "what are the acceptance criteria for the payments requirement and which tasks are still open?" and gets a correct, cited answer using only their workspace's model key. A member of another workspace provably cannot retrieve those chunks (test at the RLS layer, not just the API).

---

## M10 — Hybrid retrieval: graph + vectors

### Goal
Answers that use lineage, not just similarity — the moat identified in ADR 0011.

### Shape
- **Graph-aware retrieval:** classify the question (lineage/status vs. content); for lineage questions, walk requirement→spec→task→artifact edges directly (SQL, no embeddings) and feed structured results to the model; for content questions, vector search; for mixed, both.
- **Structured answers:** status/progress questions answered from the graph are exact, not generated — the model narrates data it's given, reducing hallucination on the questions stakeholders ask most ("is X done?").
- **Discussions ingestion:** PromptZone-native discussions index by default; `pmo`-mirrored comments (Jira) are **workspace opt-in** (third-party content, per ADR 0011).
- **Eval harness:** a small golden-question set per fixture project (lineage, content, cross-artifact, permission-boundary); run on retrieval changes. Gate M11 on M9/M10 usage + eval quality.

---

## M11 — Git-host integration: PRs + codebase (gated)

### Goal
Engineering-side questions ("which PR implemented T014?", "where is the rate limiter?") — without storing source code at rest.

### Shape
- **GitHub App** (GitLab later) installed by a workspace admin; token in the secret store. Webhooks: PR opened/merged, push to default branch.
- **PRs:** index title/description/review comments as normal artifacts; link PRs to tasks via the existing commit-ref convention (`T014: …` — same parser as `syncTasksFromGit`, ADR 0009), enriching the graph with implementation evidence.
- **Code:** embeddings + chunk references only (repo, path, SHA, line range). Answering fetches the referenced chunk **on demand** from the Git host with the workspace token, uses it in context, and discards it. Index refresh on push events; delta-only re-embedding.
- **Fallback** for unreachable Git hosts: desktop-side embedding sync (ADR 0011 sub-option 3) — spec only if demanded.

### Exit criteria
Code-content questions answered with file/line citations linking to the Git host; a dump of all PromptZone-cloud storage contains no source-code plaintext (embeddings + refs only) — verified by test.

---

## Cross-cutting (continuous, extends M7)

- **Backplane:** M9's ingest queue is in-process — acceptable at 1 replica, but this plan is the forcing function for Redis (queue + presence + rate-limit) before any horizontal scale.
- **Ops:** embedding-queue depth, tokens/day per workspace, and retrieval latency join the metrics endpoint; secret store becomes mandatory infra (Railway env vars suffice until M11's per-workspace Git tokens, which need a real secret manager or encrypted-at-rest table with KMS).
- **Docs:** update architecture §2.1 wording on ADR 0011 acceptance; add `apps/web` to `DEPLOYMENT.md`.
