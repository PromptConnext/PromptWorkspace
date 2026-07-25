# Cloud Planner UI — business-user PRD-to-plan flow (apps/web + apps/cloud)

**Date:** 2026-07-25 · **Scope:** `apps/web` (new UI), `apps/cloud` (three targeted backend changes) · Sub-project A of a four-part pre-launch initiative (B: Tech Lead review + AGENTS.md, C: GitHub repo creation from cloud, D: desktop clone-detection handoff — each its own spec).

Not to be confused with `2026-07-24-planner-window-design.md`, which relabels the existing 3S stepper inside `apps/desktop`. This doc is the cloud/web side: a business user with no desktop app, generating specs/plans/tasks entirely in the browser.

## Context

Pre-launch requirement: business users should be able to create a project, upload a PRD (PDF/Markdown), and have the cloud app run the Spec Kit workflow (constitution → specify → plan → tasks) against Typhoon to produce an initial plan — without installing the desktop app or connecting their own model key. A tech lead later reviews/refines that output, defines project rules, generates `AGENTS.md`, and creates the GitHub repo (out of scope here — sub-project B/C). The desktop app should then detect that cloud-created project (sub-project D).

Investigation found this is far less green-field than it looked: `apps/cloud/app/api/generation.py` already implements a **cloud-side Spec Kit generation path** (plan 0007, M1–M3), explicitly documented as "the cloud-side Spec Kit path for business users with no desktop app to run the engine's own `runStage()`." Document upload (`apps/cloud/app/api/documents.py`) and project creation (`POST /projects`, `apps/cloud/app/api/sync.py:45-55`) are also already built and working. **No `apps/web` UI exists that calls any of this** — today's web workspace page literally tells users to "link one from the desktop app." This sub-project is primarily a frontend-building exercise on a mostly-complete backend, plus two backend fixes discovered during review.

## Decisions carried in from brainstorming

- **No BYO model in the cloud Planner.** Business users never connect their own key. Every stage (including `plan`, which ADR 0013 currently gates to BYO-only over quality concerns) runs on managed Typhoon. Developers who want their own model still plan through the desktop app. This removes `PlanRequiresModelError` and the workspace BYO override path *from the Planner only* — the RAG Assistant's separate `resolve_assistant_models` path (`app/rag/models.py`) is untouched, since it's a different feature that happens to share the workspace `model-connection` endpoint.
- **PRD grounding uses full-text injection, not RAG chunk-retrieval.** The managed Typhoon connection is chat-only (`embed_model=""` by design, see `app/generation/managed.py`), so `generate()`'s existing `if conn.embed_model` retrieval branch silently never fires for it — meaning an uploaded PRD's content would never reach the model as built today. Fix: for the Planner, skip embedding-based retrieval and inject the project's uploaded document(s) full extracted text directly into the `specify`/`plan` prompt context. A project realistically has one or two PRD documents; full-text beats top-8 semantic chunks for something plan-critical, and this removes an infra dependency (managed embeddings) rather than adding one.
- **No approval gate in this sub-project.** Cloud has no endpoint that ever sets `approved_by` — the field exists on `SpecDocument` but nothing writes it. Business-user output stays "draft." Real review/approval is the Tech Lead's job (sub-project B). Keeps this scoped; matches the step ordering in the original request (generate, then review).
- **Constitution stays unpersisted for now.** `generate()`'s `constitution` stage streams back to the caller and records a `generation_runs` row but has no graph entity to land on ("isn't itself persisted to the graph in this milestone" — existing comment, still true). This may need to change for sub-project B's "defines project rules" step; noted as a known limitation, not fixed here.

## Backend changes (apps/cloud)

1. **`app/generation/routing.py`** — remove the BYO/`PlanRequiresModelError` path from Planner model selection. `select_model` (called from `generate()`) always resolves to the managed Typhoon connection for all four stages, unconditionally. `DEFAULT_STAGE_ROUTING` and the per-workspace/per-project override table (`get_stage_routing_override`) become dead code for this call site — remove them rather than leave unreachable branches. Keep `PlanRequiresModelError`'s class definition only if something else references it (check before deleting); otherwise remove.
2. **`app/api/generation.py::generate()`** — replace the `if stage in ("specify", "plan") and conn.embed_model:` branch with: `repo.list_documents(project_id)` → concatenate extracted text (cap total size similarly to how the engine's `repoSnapshot()` in `apps/engine/src/routes/projects.ts` budgets file content — same shape of problem, reuse that budgeting pattern, not the code). Drop the embedder call and `conn.embed_model` check for this path entirely (tasks stage keeps its existing "grounds on the approved plan" behavior unchanged).
3. **Tests**: `apps/cloud/tests/test_routing.py` and `test_managed_tier.py` need updating — remove/repoint any assertions about `plan` requiring BYO or about the stage-routing override table, since Planner no longer has that branch.

`POST /workspaces/{id}/model-connection` (assistant's BYO route) is untouched. `documents.py` and `sync.py::create_project` are untouched — used as-is.

## Frontend changes (apps/web)

### New Project creation
On `apps/web/src/app/w/[workspaceId]/page.tsx`: add a "New Project" action to replace/augment today's static empty-state message. Simple name-entry form → `POST /projects` (body: `workspace_id`, `name`) → navigate to `/w/[workspaceId]/p/[newProjectId]`.

### New "Planner" tab
On `apps/web/src/app/w/[workspaceId]/p/[projectId]/page.tsx`: add `"Planner"` to the existing `TABS` array (currently Graph/Tasks/Progress/Discussion), rendered first/leftmost since it's the entry point for a business user landing on a fresh project.

### Planner tab component (new)
Web-native equivalent of `apps/desktop/src/components/ThreeS.tsx`'s stepper, built for Next.js/React 19 (not a port of the React 18 component — same UX shape, new implementation matching this codebase's conventions):

- **Document upload**: drag/drop + file picker, PDF/MD, calling the existing `POST /projects/{id}/documents` unchanged. Show the extracted-text preview after upload so the user can confirm extraction worked (OCR for scanned/image PDFs is a known stub in `app/documents/ocr.py` — a scanned PDF will fail to extract; surface that as a clear "couldn't read this file, try a text-based export" error rather than silently generating from empty context).
- **Stage stepper**: Constitution (optional, collapsed by default, matching desktop's `ConstitutionSetup` pattern) → Specify → Plan → Tasks. Per stage: a text input for the business framing/goal, a "Generate" button, a live-streamed output panel consuming the existing SSE `delta`/`done`/`error` events from `POST /projects/{id}/generate/{stage}`, and a "Regenerate with feedback" affordance (the endpoint's `body.user_input` already supports this — feedback just becomes the next call's input).
- **Progress communication**: the SSE delta stream is the mechanism — render tokens as they arrive plus a stage-level status indicator (queued → generating → done/failed), addressing the "communicate AI's progress" requirement directly; no polling needed.
- **Error handling**: render the existing `429 managed_tier_rate_limited` / `429 daily_token_budget_exceeded` / `event: error` (empty-or-unparseable output) responses as retry-friendly inline banners, not crashes — all three cases are already clean, structured responses from the endpoint today.

### Out of scope for this sub-project
Approval UI, `AGENTS.md` generation, GitHub repo creation, technical-plan refinement — all sub-project B/C. Desktop-side detection of cloud-created projects — sub-project D.

## Testing

- `apps/cloud`: extend/adjust `test_routing.py` and `test_managed_tier.py` per the backend changes above; add a test for the full-text document injection path in `generation.py` (e.g. upload a doc, call `generate("specify", ...)`, assert the document's content appears in what's sent to the model).
- `apps/web`: new component tests for the Planner tab following the existing web test setup (vitest, per project memory of prior WP5 work) — cover upload → generate → stream-render → regenerate-with-feedback happy path, plus the three error-banner cases.
- Manual: `pnpm cloud` + `pnpm web`, create a workspace/project as a business user with no BYO key configured anywhere, upload a real PDF PRD, walk through all four stages, confirm generated spec content actually reflects the PRD (proves the full-text-injection fix works, not just that generation runs).
