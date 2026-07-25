# Cloud Planner UI — business-user PRD-to-plan flow (apps/web + apps/cloud)

**Date:** 2026-07-25 · **Scope:** `apps/web` (new UI), `apps/cloud` (backend changes) · Sub-project A of a four-part pre-launch initiative (B: Tech Lead review + constitution + AGENTS.md, C: GitHub repo creation from cloud, D: desktop clone-detection handoff — each its own spec). This doc also defines the **shared project-lifecycle contract** all four sub-projects depend on (see "Project Lifecycle" below) — that section is foundational and should land before any of A/B/C/D starts, even though each sub-project only *implements* its own slice of the state machine.

Not to be confused with `2026-07-24-planner-window-design.md`, which relabels the existing 3S stepper inside `apps/desktop`. This doc is the cloud/web side: a business user with no desktop app, generating specs/plans/tasks entirely in the browser.

## Context

Pre-launch requirement: business users should be able to create a project, upload a PRD (PDF/Markdown), and have the cloud app run the Spec Kit workflow (constitution → specify → plan → tasks) against Typhoon to produce an initial plan — without installing the desktop app or connecting their own model key. A tech lead later reviews/refines that output, defines project rules, generates `AGENTS.md`, and creates the GitHub repo (out of scope here — sub-project B/C). The desktop app should then detect that cloud-created project (sub-project D).

Investigation found this is far less green-field than it looked: `apps/cloud/app/api/generation.py` already implements a **cloud-side Spec Kit generation path** (plan 0007, M1–M3), explicitly documented as "the cloud-side Spec Kit path for business users with no desktop app to run the engine's own `runStage()`." Document upload (`apps/cloud/app/api/documents.py`) and project creation (`POST /projects`, `apps/cloud/app/api/sync.py:45-55`) are also already built and working. **No `apps/web` UI exists that calls any of this** — today's web workspace page literally tells users to "link one from the desktop app." This sub-project is primarily a frontend-building exercise on a mostly-complete backend, plus two backend fixes discovered during review.

## Decisions carried in from brainstorming

- **No BYO model in the cloud Planner.** Business users never connect their own key. Every stage (including `plan`, which ADR 0013 currently gates to BYO-only over quality concerns) runs on managed Typhoon. Developers who want their own model still plan through the desktop app. This removes `PlanRequiresModelError` and the workspace BYO override path *from the Planner only* — the RAG Assistant's separate `resolve_assistant_models` path (`app/rag/models.py`) is untouched, since it's a different feature that happens to share the workspace `model-connection` endpoint.
- **PRD grounding uses full-text injection, not RAG chunk-retrieval.** The managed Typhoon connection is chat-only (`embed_model=""` by design, see `app/generation/managed.py`), so `generate()`'s existing `if conn.embed_model` retrieval branch silently never fires for it — meaning an uploaded PRD's content would never reach the model as built today. Fix: for the Planner, skip embedding-based retrieval and inject the project's uploaded document(s) full extracted text directly into the `specify`/`plan` prompt context. A project realistically has one or two PRD documents; full-text beats top-8 semantic chunks for something plan-critical, and this removes an infra dependency (managed embeddings) rather than adding one.
- **No approval gate in this sub-project.** Cloud has no endpoint that ever sets `approved_by` — the field exists on `SpecDocument` but nothing writes it. Business-user output stays "draft." Real review/approval is the Tech Lead's job (sub-project B). Keeps this scoped; matches the step ordering in the original request (generate, then review).
- **Constitution must persist — this reverses an earlier assumption.** `generate()`'s `constitution` stage currently streams back to the caller and records a `generation_runs` row but has no graph entity to land on ("isn't itself persisted to the graph in this milestone" — existing comment). Since the Tech Lead's review step (sub-project B) explicitly needs to review/edit the constitution before it's usable as a real project rule set, it needs a durable home. See "Project Lifecycle" below — persistence lands in sub-project B, but the schema decision is made now so A doesn't build anything that conflicts with it.

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
Approval UI, constitution/`AGENTS.md` persistence and review, GitHub repo creation, technical-plan refinement — all sub-project B/C. Desktop-side detection of cloud-created projects — sub-project D. (Sub-project A does, however, write the initial `lifecycle_status` on project creation and implement the "Send to Tech Lead" transition — see below — since those are cheap, additive, and otherwise block B from starting cleanly. "Send to Tech Lead" is rejected with a 400 if the project has no requirement, spec document, and task yet — i.e. all three generation stages must have run at least once, though none need to be "approved" since A has no approval concept.)

## Project Lifecycle & Cloud↔Desktop Coordination

This is the answer to "how does the desktop app know planning is done, a repo exists, and a project is ready for a developer to start." It's a shared contract, not a UI — each sub-project implements the slice it owns, but the state names, storage location, and sync mechanism are fixed here so they don't drift apart.

### States

A project moves through one linear, non-branching sequence (no going back — regeneration/iteration happens *within* a state, e.g. a business user can keep regenerating specs while still in `planning`, a Tech Lead can keep editing the constitution while in `tech_review`):

```
planning → pending_tech_review → tech_review → repo_created
```

| State | Meaning | Set by | Owning sub-project |
|---|---|---|---|
| `planning` | Default on project creation. Business user is uploading PRDs / generating / regenerating draft specs, plan, tasks. | `POST /projects` (default value) | A |
| `pending_tech_review` | Business user has explicitly signalled they're done. | Business user clicks "Send to Tech Lead" | A |
| `tech_review` | Tech Lead is actively reviewing: approving spec/plan, editing the constitution, generating/reviewing `AGENTS.md`. | Automatic — the moment a Tech Lead-role user opens the review view for a `pending_tech_review` project (see "Transition rule" below) | B |
| `repo_created` | GitHub repo exists; `repo_url`/`repo_default_branch` are set. Terminal state for this lifecycle — task-level progress after this point is tracked by the existing task-graph sync, not this status field. | Tech Lead clicks "Create Repository" (explicit, gated — see below) | C |

### Transition rule

**Transitions with an external or irreversible side effect require an explicit user action. Purely internal bookkeeping transitions happen automatically as a side effect of the relevant actor's first action in that phase.** Concretely: `planning → pending_tech_review` and `pending_tech_review → tech_review` are just "whose turn is it" bookkeeping — no external effect, so they're either a lightweight explicit click (submit-for-review, cheap and gives the business user a clear "I'm done" moment) or automatic on first Tech Lead interaction. `tech_review → repo_created` creates a real GitHub repository — always an explicit, gated button click (confirmed in brainstorming), disabled until preconditions are met: spec + plan approved, constitution non-empty, `AGENTS.md` generated and reviewed.

### Storage

- **`apps/cloud`**: new columns on `pz_projects` — `lifecycle_status text not null default 'planning'`, `repo_url text`, `repo_default_branch text`. New tables for the two Tech-Lead-owned artifacts that need their own review state (not a good fit for the existing `pz_spec_documents`/`pz_requirements` shape, which are Spec-Kit-stage-specific): `pz_project_constitution` (`project_id`, `content`, `updated_by`, `updated_at`, `reviewed_by` nullable) and `pz_agents_md` (`project_id`, `content`, `generated_at`, `reviewed_by` nullable, `reviewed_at` nullable). Both are one-row-per-project (upsert on edit), not versioned history — sub-project B's call if that turns out to be insufficient.
- **`apps/engine`**: no new local table needed for the status itself — it rides the existing roster cache (the local mirror of cloud workspace/project metadata, ADR 0015) rather than engine's own `projects` table, since a project in `planning`/`pending_tech_review`/`tech_review` has no local project yet by definition (that's what `createLocalProjectShell` currently always creates from scratch — see below). Add `lifecycle_status`, `repo_url`, `repo_default_branch` to whatever roster-project row shape `loadRosterProjects()` (`apps/engine/src/cloudClient.ts`) already caches.

### Sync mechanism — reuse what exists, no new channel

The roster is already refreshed on sign-in, window focus, and explicit refresh (existing mechanism, ADR 0015 — ridden by both `apps/desktop` and now this feature, no polling loop or webhook needed for v1). Cloud's roster-serving endpoint (`GET /workspaces/{id}/projects`, `apps/cloud/app/api/workspaces.py:112`) just needs the three new columns added to its response shape. Desktop already renders roster projects with no local counterpart as `cloud:<id>` tabs (`apps/desktop/src/components/Workspace.tsx:76-101`) — sub-project D's job is to read `lifecycle_status`/`repo_url` off that same roster row and change what clicking the tab offers:

- `planning` / `pending_tech_review` / `tech_review`: informational only — "In planning" / "Awaiting tech review" / "In tech review" badge, no open action (there's nothing to clone yet, and the desktop's job isn't to let a developer watch business/tech-lead iteration).
- `repo_created`: the real payoff — desktop offers "Clone repository" instead of today's `POST /engine/cloud/projects/:cloudProjectId/open` behavior, which unconditionally does `git init` into an empty folder (`createLocalProjectShell`, `apps/engine/src/routes/projects.ts`). This needs a new code path (`git clone <repo_url>` instead of `git init`) — full implementation is sub-project D; this doc only fixes the contract (which field, what it means) D builds against.

### Answering the three original questions directly

- **Has the planning phase been completed?** `lifecycle_status != 'planning'` (i.e. business user has sent it to tech review or beyond).
- **Has a Git repository been created?** `repo_url is not null` (equivalently `lifecycle_status == 'repo_created'` — kept as two checks because `repo_url` is what desktop actually needs functionally, `lifecycle_status` is what it needs for the badge).
- **Is the project ready for developers to start implementation?** Same as above — `repo_created` is defined as "ready," by design (nothing else gates it once the repo exists).

## Testing

- `apps/cloud`: extend/adjust `test_routing.py` and `test_managed_tier.py` per the backend changes above; add a test for the full-text document injection path in `generation.py` (e.g. upload a doc, call `generate("specify", ...)`, assert the document's content appears in what's sent to the model).
- `apps/web`: new component tests for the Planner tab following the existing web test setup (vitest, per project memory of prior WP5 work) — cover upload → generate → stream-render → regenerate-with-feedback happy path, plus the three error-banner cases.
- Manual: `pnpm cloud` + `pnpm web`, create a workspace/project as a business user with no BYO key configured anywhere, upload a real PDF PRD, walk through all four stages, confirm generated spec content actually reflects the PRD (proves the full-text-injection fix works, not just that generation runs).
- Lifecycle (this sub-project's slice only): a new project defaults to `lifecycle_status = 'planning'`; "Send to Tech Lead" flips it to `pending_tech_review` and is rejected (400) if no requirement/spec/task exists yet. Full B/C/D transitions are tested in their own specs, but A's tests should assert the roster payload actually carries the new columns end-to-end (cloud response → engine's cached roster row), since that's the seam the other three sub-projects build on.
