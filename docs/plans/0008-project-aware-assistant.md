# Plan — Project-aware AI assistant for the business team (cloud chat)

**Date:** 2026-07-17 · **Status:** Proposed · **Scope:** `apps/cloud` + `apps/web`
**Implements:** ADR 0011 (RAG assistant) · **Depends on:** plan `0007-managed-thai-llm-tier-pilot.md` (M0 documents, M2 managed tier) · **Follows:** plan `0005-cloud-workspace-rag-assistant.md` (M9–M10)
**Depth:** task-level, one milestone per session/PR.

## What already exists — read this first

**The retrieval brain is ~80% built.** ADR 0011 + plan 0005 M9–M10 shipped a hybrid, membership-scoped assistant at `POST /projects/{id}/assistant/chat` (SSE). It already answers exactly the question classes the business team wants, and it's important not to re-plan it:

- **Status / progress / assignees / ownership / "how many"** → `rag/classify.py` routes these to an **exact graph walk** (`rag/lineage.py`: project/requirement/task scope, `task_status_counts`, `tasks_done`, per-task assignee and agent-runs) — no embeddings, no hallucination. `_project_facts` already computes project-level progress rollups.
- **Requirements / PRDs / specs / plans / design / "why"** → **vector search** over `pz_rag_chunks` (`rag/embedder.py` + `repo.vector_search`), membership pre-filtered before similarity (ADR 0011).
- **Mixed** questions get both; code questions fetch-on-demand from Git (never stored). Every answer streams with **citations** back to graph nodes, under a **daily token budget** and prompt-injection-hardened system prompt.

**So this plan is the delta, not a rebuild.** Three real gaps stand between that endpoint and a business-facing "project-aware assistant":

1. It **hard-requires a workspace BYO model key** (`chat` returns 400 `model_connection_not_configured`) — a business-only workspace on the ADR 0013 managed tier can't use it at all.
2. It is **single-shot** (`ChatRequest = {question}`) — no follow-ups, no history.
3. There is **no chat UI in `apps/web`** — the tabs are Graph/Tasks/Progress/Discussion; the endpoint is unreachable from the browser.

Uploaded PRDs/design docs become answerable automatically once plan 0007 **M0** lands (`documents` node_type flows into `pz_rag_chunks`, so `vector_search` picks them up) — this plan only has to surface their citations nicely.

```
0007 M0 documents ─┐         0007 M2 managed tier ─┐
                   ▼                               ▼
M1 keyless/managed assistant + platform embeddings ──> M2 multi-turn + persisted history ──> M3 web right-drawer UI
```

---

## M1 — Make the assistant work keyless (managed tier + platform embeddings)

### Goal
A business workspace with **no** BYO key can ask the assistant and get both graph-fact and content answers, using the managed Typhoon chat model (plan 0007) and a **platform-hosted multilingual embedding model**.

### Shape
- **Model-source resolution**: refactor `chat`'s `conn = repo.get_model_connection(...)` into a `resolve_assistant_models(workspace_id) -> (chat_conn, embed_conn)` that returns, in priority order, the workspace BYO connection, else the **managed** source (from plan 0007 `select_model`). Everything downstream (`HttpChatProvider`, `HttpEmbeddingProvider`, budget, SSE) is unchanged — this is the OpenAI-compatible-boundary payoff again.
- **Platform embedding model** (the one genuinely new dependency): Typhoon is generation-only, so the managed tier needs a separate embeddings endpoint. Recommend a **BGE-m3-class multilingual model** (strong Thai + English, open weights) served over an OpenAI-compatible `/embeddings` (Text-Embeddings-Inference or vLLM) — `HttpEmbeddingProvider` talks to it unmodified. Config in `Settings`: `managed_embed_base_url`, `managed_embed_model`, `managed_embed_dim`.
- **The embedding-dimension constraint (must-handle, not optional):** `pz_workspace_model_connections.embed_dim` defaults 1536 and `pz_rag_chunks.embedding` is a **fixed-dim** ivfflat column. Chunks embedded with model A **cannot** be queried with model B of a different dimension. Therefore a **project's chunks must be homogeneous** in embed model. Store the embed model/dim used per project (or per chunk), reject a query whose resolved embed model ≠ the chunks' model, and require a **reindex** when a workspace switches embedding source (BYO ↔ managed). M0/M9 reindex already exists — reuse it. Do **not** silently mix dimensions.
- **Keyless graph-fact answers** need no embeddings at all — ensure a `lineage`-classified question answers even if the embedding endpoint is down (status/assignee questions must be the most reliable path).

### Tests
- `test_assistant_keyless.py`: a workspace with no BYO connection gets a graph-fact answer (managed chat, no embeddings) **and** a content answer (managed chat + platform embeddings, fake providers); a dimension-mismatch query is rejected with a clear reindex error; budget enforced against the managed source.

### Exit criteria
A brand-new business workspace (no key) asks "what's the status?" and "summarize the payments PRD" and gets correct, cited answers entirely on the managed tier.

---

## M2 — Multi-turn conversation + persisted history

### Goal
Follow-up questions that reference earlier turns ("what about task T003?"), with conversations saved and reopenable.

### Shape
- **Schema** (migration, next number): `pz_assistant_threads (id, workspace_id, project_id, created_by, title, created_at, updated_at)` and `pz_assistant_messages (id, thread_id, role, content, citations jsonb, created_at)`. RLS-scoped to workspace membership (mirror `pz_rag_chunks`). Title auto-derived from the first question.
- **Request/response**: extend `ChatRequest` to `{ question, thread_id? }`. The endpoint loads prior turns for `thread_id`, includes a **windowed** history in the model context (budget-aware — trim oldest turns, never the system prompt or the current retrieval context), persists the user question and streamed answer + citations. New endpoints: `GET /projects/{id}/assistant/threads`, `GET …/threads/{tid}`, `POST …/threads` (implicit-create on first message is fine).
- **Retrieval per turn**: re-run classification + retrieval on **each** question (state changes between turns — a status answer must reflect the latest graph), but resolve pronouns/references using the history window. Don't cache facts across turns.
- **Budget**: history tokens count against the daily budget like everything else; the window cap is both a quality and a cost control.

### Tests
- `test_assistant_threads.py`: a thread persists across two turns; the second turn resolves a reference to the first; a non-member can't read another workspace's thread (RLS-layer test); history is windowed when it would exceed the budget.

### Exit criteria
A user asks "how many tasks are open?", then "who owns the blocked one?" and gets a correct answer that used the first turn's context — and the conversation is still there after refresh.

---

## M3 — Web right-drawer assistant (persistent across project tabs)

### Goal
A dockable **right drawer** (the IdevaKit pattern) available on every project tab, so the team asks without leaving Graph/Tasks/Progress/Discussion.

### Shape
- **`apps/web` components**: `components/project/AssistantDrawer.tsx` (toggle from `TopBar`, open across all tabs — lift the toggle to the project page shell so it persists when `tab` changes), `AssistantMessage.tsx` (renders streamed markdown + a **graph-facts** block from the `event: facts` SSE frame + **citations** as links that deep-link into `GraphBrowser`), and a thread list/switcher.
- **Streaming client** `lib/assistant.ts`: POST to `/projects/{id}/assistant/chat` and parse the SSE stream (`data:` deltas, `event: facts`, `event: citations`) — a plain `fetch` + `ReadableStream` reader; **no** WebSocket (unlike presence). Scope every call to the **active** `projectId`.
- **Discoverability**: seed the empty state with starter questions ("What's the current status?", "Who's working on what?", "Summarize the latest spec", "What changed since last week?") so business users see what it can do without training.
- **Citations render as trust**: clicking a citation opens that requirement/spec/task/document in the graph browser — the "don't manually search" payoff.

### Tests
- Component tests (or Playwright if configured): drawer opens on each tab and survives tab switches; a streamed answer renders deltas + a facts block + clickable citations; the thread switcher loads a past conversation.

### Exit criteria
On the active project, a business user opens the drawer from any tab, asks a question in Thai, watches the answer stream with a status block and citations, clicks a citation to jump to the source node, and reopens yesterday's thread.

---

## Cross-cutting

- **Uploaded documents & design** (plan 0007 M0): add `documents` to `classify.py`'s content markers and to citation rendering (label + link to the document node) so "summarize the uploaded PRD" and "what does the design say?" cite the right source. No retrieval change — `vector_search` already covers the node type.
- **Membership scoping everywhere**: threads, messages, retrieval, and facts all pre-filter by `workspace_id`/`project_id`; test at the RLS layer, not just the API (plan 0005 M9 precedent).
- **Budgets from turn one**: history + retrieval + answer all count against `DailyTokenBudget`; the managed embedding calls too.
- **Prompt-injection posture unchanged**: retrieved artifact/document text stays **data, not instructions** (ADR 0011) — the assistant is read-only, no tool-use that mutates the graph in this plan.
- **Reuse, don't rebuild**: this plan adds a model-resolution refactor, two tables, a UI drawer, and classifier/citation tweaks — it does **not** add a second retrieval stack. If a milestone seems to need one, re-read `rag/`.

## Ordering & driving Sonnet

Order is **0007 M0 + M2 first** (documents + managed tier are dependencies), then **M1 → M2 → M3** here. One milestone per session/PR; start Claude Code at the repo root and, per milestone, tell it to **read `api/assistant.py`, `rag/classify.py`, `rag/lineage.py`, `rag/chat.py` first and extend them** rather than build parallel machinery, write the listed tests, and pass `pytest` + `ruff` before stopping for review. M1's keyless path can't be integration-tested end-to-end until plan 0007 M2 exists, so stub the managed source with the existing `FakeChatProvider`/`FakeEmbeddingProvider` pattern until then.
