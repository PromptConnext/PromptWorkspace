# Implementation prompts — plan 0005 (cloud workspace & RAG assistant)

Copy-paste prompts for driving Claude (Sonnet) through plan 0005, one milestone per session/PR. Give each session the **kickoff preamble + one milestone prompt**. Don't ask for multiple milestones at once — the plan's ordering and gates exist for a reason.

---

## Kickoff preamble (prepend to every session)

```
You are implementing part of PromptZone. Before writing any code, read these in order:

1. docs/decisions/0011-cloud-workspace-rag-assistant.md — the decision and its boundaries
2. docs/plans/0005-cloud-workspace-rag-assistant.md — the milestone plan; you are implementing exactly ONE milestone (specified below)
3. docs/promptzone-platform-architecture.md §2 — the deployment shape you must not break
4. apps/cloud/README.md and the existing code in apps/cloud/app/ — match its conventions

Hard rules:
- Scope: only the milestone named below. If you find prerequisite gaps, list them and stop — don't silently expand scope.
- Every apps/cloud feature must work in BOTH data backends: `memory` (used by tests, no external deps) and `supabase`. Add the memory implementation first; tests must pass with no network.
- Membership scoping is structural: new tables get RLS policies (new numbered migration in apps/cloud/migrations/), and new endpoints go through the existing auth dependency. Write a test proving a non-member CANNOT access the new resource.
- No secrets in Supabase rows or in code. Follow the existing pattern: env / secret-ref only.
- Never block the sync upsert path on external calls (embedding, model, Git host) — background/async only.
- Tests: pytest for apps/cloud (extend existing test style in apps/cloud/tests/). Run pytest and ruff before declaring done.
- The milestone's "Exit criteria" section in plan 0005 is your definition of done. Demonstrate each criterion, ideally as an automated test.
- Update docs you invalidate (README, DEPLOYMENT.md) in the same PR.

Work plan first: produce a short file-by-file plan and the migration DDL, wait for my approval, then implement.
```

---

## M8 — Web workspace

```
Milestone: M8 (plan 0005) — new app apps/web.

Next.js App Router + TypeScript + Tailwind, Supabase Auth on the client, calling the existing apps/cloud API with the user's JWT. Read-only views: workspace switcher, project list, graph/lineage browser (requirement → spec → task → artifact → agent-run), task board showing per-field authority (pz/pmo), progress roll-ups, invitation accept flow.

Constraints beyond the preamble:
- No new backend endpoints unless a read genuinely doesn't exist — list any you think you need and stop for approval first.
- Reuse the graph/sync read endpoints (GET /sync/projects/{id}/graph etc.) exactly as the desktop client does — see apps/engine's sync client for the envelope shapes.
- Add the web origin to CORS_ORIGINS docs; document local dev (web app + cloud in memory/stub mode) in apps/web/README.md.
- Auth against AUTH_MODE=stub for local dev must work (X-User-Id header path) so the app is testable without Supabase.

Exit criteria: plan 0005 §M8.
```

## M9 — RAG assistant v1

```
Milestone: M9 (plan 0005) — RAG over already-synced artifacts.

Deliverables:
1. Migration: pgvector, rag_chunks, workspace_model_connections (secret_ref only — no key material in Postgres). Memory-backend equivalents.
2. Embed-on-ingest: async queue hooked into the sync upsert path (never blocking), chunking ~500 tokens with overlap, tombstone-driven chunk deletion in the existing GC loop, admin-triggered backfill per project.
3. POST /workspaces/{id}/model-connection with a live health-check validation call (mirror the desktop onboarding gate pattern).
4. POST /projects/{id}/assistant/chat — SSE streaming; retrieval is membership-filtered BEFORE similarity search; response carries citations [{node_type, node_id, chunk_index}].
5. Guardrails: retrieved text treated as data (no tool use, hardened system prompt); per-workspace daily token budget; reuse the existing rate limiter.

For tests, stub the model/embedding provider the way GEMINI_STUB_MODE-style fixtures work elsewhere in the org's repos: a deterministic fake provider selected by env var, never in production.

Exit criteria: plan 0005 §M9 — including the cross-tenant isolation test at the RLS layer, not just the API layer.
```

## M10 — Hybrid retrieval

```
Milestone: M10 (plan 0005) — graph-aware retrieval on top of M9.

1. Question classifier (lineage/status vs content vs mixed) — cheap heuristic or single model call, your call, justify it.
2. Lineage/status questions answered from graph walks (SQL, exact) with the model narrating supplied data; content questions via vector search; mixed uses both.
3. Eval harness: golden-question set over a fixture project (lineage, content, cross-artifact, permission-boundary) runnable in CI with the stub provider.

Note: discussions ingestion is NOT in this milestone (no Discussion entity exists — descoped to M12). Keep retrieval node_type-extensible so M12 chunks slot in without rework.

Exit criteria: eval set passes; a status question ("is requirement X done?") returns graph-exact data, verified by test.
```

## M11 — Git-host integration (gated — confirm M9 usage before starting)

```
Milestone: M11 (plan 0005) — PRs + code, no source at rest.

1. GitHub App integration: install flow (admin), webhook receiver (PR opened/merged, push to default branch) following the existing webhook HMAC-verification pattern.
2. PRs indexed as artifacts; task linkage via the T-ref commit convention (same parser semantics as syncTasksFromGit, ADR 0009).
3. Code: embeddings + chunk references (repo, path, SHA, line range) ONLY. Answer-time chunks fetched on demand with the workspace token and discarded. Delta re-embedding on push.
4. Storage-posture test: assert no source-code plaintext exists in any cloud table after a full index + chat cycle.

Exit criteria: plan 0005 §M11.
```

## M12 — Discussions (entity + collaboration + ingestion)

```
Milestone: M12 (plan 0005) — Discussion entity end-to-end.

1. Discussion entity: schema migration + sync payload + memory-backend parity + tombstones; per-field authority — pz-native comments vs pmo-mirrored (Jira via M5 boundary).
2. Web UI (extends M8): comment threads on graph nodes; authoring allowed for discussions only.
3. RAG ingestion (extends M9): add discussions to RAG_NODE_TYPES / node_text(); native discussions default-in, pmo-mirrored comments workspace opt-in (ADR 0011).
4. Resolve the Artifact content gap flagged in apps/cloud/app/rag/source.py: add a content field or record a deliberate exclusion.

Exit criteria: plan 0005 §M12 — web comment → desktop sync → cited assistant answer; opted-out pmo comments unretrievable; RLS boundary tested.
```

---

## Tips for running these

- One milestone = one branch/PR. Review the work plan Sonnet proposes before letting it implement — that checkpoint catches scope drift cheaply.
- If a session degrades (context bloat, repeated mistakes), start fresh: the preamble + milestone prompt + "continue from the current branch state" recovers cleanly.
- After each milestone, update plan 0005's status line and note deviations — the docs are the contract for the next session.
```
