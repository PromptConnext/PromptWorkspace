# Plan — Managed Thai-LLM tier (Typhoon): pilot slice

**Date:** 2026-07-17 · **Status:** M0–M2 implemented; M3 superseded by [ADR 0013](../decisions/0013-managed-thai-llm-tier-stage-routing.md)'s 2026-07-25 update (no routing table); M4 never planned · **Scope:** `apps/cloud` + `apps/web`
**Implements:** ADR 0013 (Part B) · **Follows:** plan `0005-cloud-workspace-rag-assistant.md` (M8–M12)
**Depth:** task-level, meant to be executed by Claude Code (Sonnet) one milestone per session/PR.

This is the **pilot slice** of ADR 0013, deliberately GPU-free: a per-stage **model router** plus a **managed tier backed by the free `opentyphoon.ai` API**, behind the token budgets that already exist. It proves the whole workflow end-to-end (business user uploads a PRD, then generates a spec online, in Thai, with no desktop app) at near-zero cost, and is the ADR's phased **D → A** path. Self-hosting the GPU pool (ADR 0013 §3) is explicitly **out of scope here** and deferred to a follow-up plan.

**M0 is the load-bearing addition for business users:** without a desktop app they have no local files to sync, so the project **knowledge base** — uploaded PRDs, Markdown, later Figma — becomes the only substantive context `specify` and `plan` can draw on. M0 ships the upload → extract → embed path; M1's generation service consumes it as retrieval context.

```
M0 knowledge base (upload PDF/MD → extract → embed) ─┐
                                                     ▼ (retrieval context)
M1 stage prompts + generation endpoints ──> M2 managed tier (free Typhoon) ──> M3 routing table + overrides + web picker
   (defaults to workspace BYO model)            (behind budgets/rate limits)       (per-stage, per-workspace)
                                                                                 M4 self-host pool  ← deferred (separate plan)
```

---

## Surface decision — put generation in `apps/cloud`, do **not** relay to the engine

ADR 0013 left this open ("recommend in the plan"). Recommendation: **build the managed generation endpoints in `apps/cloud`, reusing the RAG plumbing already there.** Concretely, `apps/cloud` already has everything the managed tier needs:

- `app/rag/chat.py::HttpChatProvider.stream_chat(context, question, model, api_key, base_url)` — an **OpenAI-compatible** streaming client hitting `base_url + /chat/completions`. Typhoon's API is OpenAI-compatible, so it is a `ModelConnection` like any other.
- `app/rag/budget.py::DailyTokenBudget` + `estimate_tokens` — per-workspace token ceilings.
- `app/api/assistant.py::set_model_connection` + `app/secrets.py` — BYO key storage, never in Postgres.
- SSE streaming, membership scoping, and the rate-limit stack, all already wired.

The alternative — relaying to the **engine's** `runStage()` — is rejected: it couples the cloud to a *running local engine*, which directly contradicts the premise of ADR 0013 (business users with **no** desktop app). The engine keeps its own `runStage()` for desktop/local-node flows (ADR 0012); the cloud gets a parallel, self-contained generation path.

**The one real gap:** the Spec Kit **stage prompt templates** live in the engine (`apps/engine/src/agent/templates/*.md` and `loop.ts::driverPrompt()` for `constitution | specify | plan | tasks`). M1 ports them into `apps/cloud` as the single source for cloud-side generation. Keep the template text identical so cloud- and engine-generated artifacts stay consistent.

**Knowledge base rides the existing RAG pipeline.** M0's ingestion reuses what plan 0005 M9 already built: `pz_rag_chunks` (pgvector, RLS-scoped by `workspace_id`/`project_id`), `EmbedQueue` + `embed_worker_loop` (async, never blocks a request), `chunk_text`, `HttpEmbeddingProvider` (OpenAI-compatible `/embeddings`), and the membership-scoped retrieval in `assistant.chat`. Uploaded artifacts become a **new `node_type = "documents"`** flowing through those same rails — the `code_file` special-case in `queue.py::_process_job` is the precedent for a node type whose text comes from outside the graph tables.

---

## M0 — Project knowledge base: artifact upload → extract → embed

### Goal
A business user with no desktop app uploads project artifacts (**PRD PDFs, Markdown**) in the web app; each becomes a **first-class `documents` graph entity** *and* embedded knowledge, so `specify`/`plan` can ground on it. Figma is deferred behind an adapter seam (below).

### Shape
- **Upload endpoint** `app/api/documents.py`: `POST /projects/{id}/documents` (multipart), same auth + membership + rate-limit stack as the rest of the cloud. Accepts `application/pdf`, `text/markdown`, `text/plain`. Stores the raw file in **Supabase Storage** (bucket per workspace, RLS-scoped); metadata row in Postgres. Size/type caps enforced server-side.
- **Text extraction** `app/documents/extract.py`, dispatched by MIME:
  - **Markdown / plain text** → passthrough (strip front-matter).
  - **PDF** → **text-layer first** (e.g. `pypdf`); if the extracted text is empty/near-empty (scanned/image PDF), **fall back to `typhoon-ocr`** via the managed source (ADR 0013 earmarks this exactly). OCR is the same OpenAI-compatible boundary — no new client. Record which path ran on the document row.
  - **Figma** → **not implemented in the pilot**; see the adapter seam.
- **First-class entity**: extend the graph with `node_type = "documents"` — a `Document` schema (`id, project_id, title, mime, storage_ref, source_kind, extract_method, status, created_at`), surfaced in the web **graph browser** and linkable to requirements/specs so lineage runs **source PRD → spec → task** (matches plan 0005's lineage story). Add via the sync/upsert projection path, RLS-scoped.
- **Embed**: on successful extraction, `enqueue(EmbedJob(node_type="documents", node_id=doc_id, …))`; extend `node_text()`/`_process_job` to read the extracted text (persisted, unlike `code_file`), then `chunk_text` + `HttpEmbeddingProvider` into `pz_rag_chunks` — identical to every other node type from there on.
- **Source-adapter seam** `app/documents/sources.py`: a small `DocumentSource` protocol (`fetch() -> bytes|str`, `mime`, `source_kind`) so `upload` is one implementation and **`figma-mcp` is a future one** — a Figma MCP adapter pulls selected frames/nodes as structured text and feeds the *same* extract→embed path. Building the seam now (not the Figma impl) is the deferral decision.

### Schema
- Migration (`apps/cloud/migrations/`, next number): `pz_documents` table + RLS policy scoped to workspace membership (mirror `pz_rag_chunks`). Extend the `pz_rag_chunks.node_type` comment to include `'documents'`. Supabase Storage bucket + policy.

### Tests (`apps/cloud/tests/`)
- `test_documents.py`: markdown upload → chunks appear in `pz_rag_chunks` for that project; a born-digital PDF extracts via text-layer (assert OCR **not** called); an image-only PDF triggers the `typhoon-ocr` fallback (fake OCR provider); a non-member is 403; oversize/unsupported type is 415/413; another workspace provably cannot retrieve the chunks (RLS-layer test).

### Exit criteria
A member uploads a Thai PRD (born-digital **and** a scanned one), sees both as `documents` nodes in the graph browser, and a retrieval query returns chunks from them — the scanned one via OCR fallback.

---

## M1 — Stage prompts + generation endpoints (router-ready, still BYO)

### Goal
The web app can POST a Spec Kit stage and stream back a generated artifact from the **workspace's existing BYO model** (the `model-connection` from ADR 0011). No Typhoon yet — this milestone stands up the generation path and the router seam without any new model.

### Shape
- **Port stage templates** → `app/generation/templates/` (copy `constitution-template.md`, `spec-template.md`, `plan-template.md`, `tasks-template.md` + the command prompts from `apps/engine/src/agent/templates/`). Add `app/generation/prompts.py` mirroring `driverPrompt()` — a `StageKind = Literal["constitution","specify","plan","tasks"]` and a `driver_prompt(kind) -> str`.
- **Generation service** `app/generation/service.py`: `generate_stage(kind, user_input, conn) -> AsyncIterator[str]` — assembles the driver prompt + **retrieved knowledge-base context** + upstream Spec Kit docs, calls a chat provider (reuse/generalize `HttpChatProvider`), streams deltas. Parse the artifact out of the completion the same way the engine does (`parseFiles`/`extractDocument` equivalents).
- **Knowledge-base context (the M0 payoff)**: for `specify` and `plan`, before generating, run the **same membership-scoped vector retrieval** `assistant.chat` uses (embed the user input + a stage-specific query, pull top-k `pz_rag_chunks` for the project including `node_type = "documents"`), and inject the hits as grounded context with their source doc titles. This is what makes an uploaded PRD actually steer the generated spec. `constitution` uses it lightly (principles rarely need doc grounding); `tasks` grounds on the approved spec, not raw uploads. Retrieval reuses the M0 embedding provider and the existing pre-filter-before-similarity pattern (ADR 0011) — no cross-workspace leakage.
- **Endpoint** `app/api/generation.py`: `POST /projects/{id}/generate/{stage}` (SSE), same auth + membership + rate-limit + budget stack as `assistant.chat`. Body: `{ user_input, options? }`. On completion, persist the artifact into the graph via the existing sync/upsert path so it appears in the web graph browser (ADR 0010 projection) and, for `tasks`, emits `{text: string}[]` acceptance criteria — **do not change that shape** (CLAUDE.md).
- **Model selection stub**: a `select_model(workspace_id, project_id, stage) -> ModelConnection` function that in M1 **always returns the workspace BYO connection**. This is the router seam M3 fills — introduce it now so M3 is a change in one place.

### Schema
- New table `generation_runs (id, workspace_id, project_id, stage, model_source, model, status, prompt_tokens, completion_tokens, created_at)` — audit + cost accounting. Migration under `apps/cloud/migrations/` (next number), with the RLS policy scoping rows to workspace membership (mirror the `rag_chunks` policy from plan 0005 M9).

### Tests (`apps/cloud/tests/`)
- Reuse the `FakeChatProvider` pattern from `rag/chat.py` for a network-free `FakeGenerationProvider`.
- `test_generation.py`: each stage returns a streamed artifact; the run is recorded; budget is decremented; a non-member is 403; an over-budget workspace is 429.

### Exit criteria
A signed-in member POSTs `specify` with Thai requirement text and their workspace's BYO key, and the web app streams a spec **that visibly reflects a PRD uploaded in M0** (a fact only present in the uploaded doc appears in the generated spec), which then appears in the project graph. No Typhoon, no router logic yet — just the path.

---

## M2 — Managed tier: the free Typhoon API as a platform model source

### Goal
A workspace with **no** BYO key can generate, using a PromptConnext-operated **managed** model source backed by the free `opentyphoon.ai` API.

### Shape
- **Config** (`app/config.py` `Settings`): `managed_model_enabled: bool = False`, `managed_model_base_url` (default `https://api.opentyphoon.ai/v1`), `managed_model_name` (default `typhoon-v2.5-30b-a3b-instruct`), `managed_model_api_key` (from secret store/env, **platform-held**, never per-user). Verify the current base URL/model id against Typhoon docs at build time — ADR 0013 flags the API is mid-transition.
- **Managed as a `ModelConnection`**: `select_model` can now return a platform-level connection (source = `managed`) built from config, with no per-workspace key. Everything downstream (`HttpChatProvider`, budget, SSE) is unchanged — this is the payoff of the OpenAI-compatible boundary.
- **Guardrails for a shared free key**: the free API is rate-limited (5 req/s, 200 req/min, shared). Put managed calls behind (a) the existing token-bucket limiter keyed globally for the managed source, and (b) a conservative per-workspace daily budget. On upstream 429, surface a clear "managed tier busy, try again or connect your own key" — never a silent failure.

### Tests
- `test_managed_tier.py`: managed source selected when a workspace has no BYO connection; platform key is used (assert the key never comes from a workspace row); upstream 429 maps to a typed, retryable error; budget enforced.

### Exit criteria
A brand-new workspace with no model connection generates a `constitution` and `specify` through the managed Typhoon source, end to end, with the platform key — and a load test confirms the global limiter protects the shared free key.

---

## M3 — Stage routing table + per-workspace/project overrides + web picker

### Goal
Realize ADR 0013's routing table: `constitution/specify/tasks` default to **managed Typhoon**, `plan` defaults to **BYO/frontier**; every default is overridable per workspace and per project.

### Shape
- **Routing table** in `select_model`: a default map `{constitution: managed, specify: managed, plan: byo, tasks: managed}`, then overridden by a `stage_model_routing` setting resolved **project → workspace → default**.
- **Schema**: `stage_model_routing (workspace_id, project_id NULL, stage, model_source, model NULL)` — NULL `project_id` = workspace-wide default. RLS-scoped. Small admin endpoints to read/write it (`GET/PUT /workspaces/{id}/routing`, project-level variant).
- **`plan` fallback**: if `plan` routes to BYO/local-node but none is configured, fail with an explicit "plan requires a connected model — connect a key or route it to the managed tier" rather than silently using managed (ADR 0013 warns managed Typhoon underperforms on `plan`).
- **Web** (`apps/web`): a **Model source** panel in project/workspace settings — Managed / BYO key / (later) Local node — plus a per-stage override table defaulting business workspaces to Managed. Small read/write against the routing endpoints; no new WebSocket.

### Tests
- `test_routing.py`: default table applied; project override beats workspace override beats default; `plan` with no BYO errors clearly; a fully-Thai workspace can route `plan` to managed via override.

### Exit criteria
A business workspace generates `constitution → specify → tasks` on managed Typhoon and `plan` on a connected BYO key, with the split visible and editable in the web settings — matching the ADR 0013 routing table.

---

## M4 — Self-hosted Typhoon pool *(deferred — separate plan)*

Out of scope for the pilot. When managed-tier usage justifies the GPU spend (ADR 0013 §3, action items 1–3): stand up FP8 `typhoon-v2.5-30b-a3b-instruct` on vLLM behind an OpenAI-compatible endpoint, point `managed_model_base_url` at it, add scale-to-zero + membership-scoped load. **No code above the `ModelConnection` boundary changes** — that is the whole reason the pilot is safe to ship first.

---

## Cross-cutting

- **License:** standardize on the Qwen3-based **30B** (Apache-class), per ADR 0013 — avoids the Gemma-terms question on the 12B.
- **Budgets are the cost backstop** in every milestone; wire `DailyTokenBudget` from M1, don't bolt it on later. M0's OCR fallback also spends managed tokens — budget it too.
- **Membership-scope everything**: uploads, retrieval, and generation all pre-filter by `workspace_id`/`project_id` before any similarity search or model call, and test at the RLS layer (not just the API), per plan 0005 M9.
- **Reuse, don't rebuild**: M0 adds a `node_type`, an extractor, and a source seam — it does **not** add a second embedding/queue/retrieval stack. If a milestone seems to need parallel machinery, that's a signal to look at `rag/` first.
- **Don't touch retired/independent surfaces**; keep the engine's `runStage()` intact (desktop + ADR 0012 local node still use it). The desktop path already has its own Figma import — the cloud `figma-mcp` adapter is a separate, later surface.
- **Migrations** are plain SQL in `apps/cloud/migrations/`, applied in order — include the RLS policy in the same migration as each new table.

---

## How to drive Sonnet (Claude Code) to implement this

The plan above **is** the hand-off artifact — it's written so each milestone is a self-contained, testable unit. Recommended workflow:

1. **One milestone per session and per PR**, in order **M0 → M1 → M2 → M3**. Start Claude Code at the repo root (it will read `CLAUDE.md` automatically) and prompt: *"Implement M0 from `docs/plans/0007-managed-thai-llm-tier-pilot.md`. Follow the house conventions in CLAUDE.md. Reuse the `rag/` pipeline as the plan describes — do not build a second embedding/queue/retrieval stack. Write the tests under M0's Tests, run `pytest` and `ruff check .` in `apps/cloud`, and stop for review before M1."* Keeping each milestone small keeps Sonnet's context focused and the diff reviewable. M0 must land before M1, since M1's exit criterion depends on it.

2. **Point it at the grounding files.** The plan names them (`rag/chat.py`, `rag/budget.py`, `api/assistant.py`, `secrets.py`, engine `agent/templates/`). Tell Sonnet to read those first and **reuse** them rather than inventing parallel machinery — that's the difference between a 200-line PR and a 2,000-line one.

3. **Tests are the acceptance gate, not a nicety.** Each milestone lists exit criteria and test files. Ask Sonnet to write the tests first (or alongside) and to not mark a milestone done until `pytest` + `ruff` pass. `apps/cloud` is the one app with a suite, and the `FakeChatProvider` pattern means these run network-free.

4. **Verify at the boundary.** After each milestone, have Sonnet demonstrate the exit criterion (a passing integration test that streams a stage through the fake provider), then you review the diff and the migration before merging.

5. **Let the task list track it.** If you're driving from this session, I can turn each milestone into tracked tasks; in a fresh Claude Code session, ask it to use its own todo tracking per milestone.

Because this repo *is* a Spec Kit tool, an alternative is to dogfood it: feed this plan in as the project's own `tasks.md` and let the workflow drive implementation. Either way, the plan's task-level granularity and per-milestone exit criteria are what make it safe to delegate to Sonnet without hand-holding each step.
