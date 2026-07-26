# Editable Markdown for Planner stages (apps/web + apps/cloud)

**Date:** 2026-07-26 · **Scope:** `apps/cloud` (new persistence + RAG wiring), `apps/web` (reusable editor component, Planner integration)

## Context

The Planner tab (`apps/web/src/components/project/Planner.tsx`) streams generated `constitution`/`specify`/`plan`/`tasks` output from `POST /projects/{id}/generate/{stage}` into a plain `<pre>` block — raw text, not markdown-rendered, and not editable. The original ask was "add a Raw | Preview edit toggle," but investigation surfaced a prerequisite gap: none of the four stages survive a page reload today. `StageSection`'s `streamedText` lives only in component state; even `plan`'s output, which does get persisted server-side as `SpecDocument.content`, is never fetched back by the frontend. Editing only makes sense once there's something durable and re-fetchable to edit.

Rather than bolt persistence onto the existing per-stage graph-entity shapes — `specify` only keeps the user's prompt (`Requirement.description`), `tasks` destructures into individual `Task` rows losing the combined document, `constitution` isn't persisted anywhere — this design adds a small, uniform side-store for the raw markdown, orthogonal to the existing graph-upsert parsing. The graph entities keep doing what they do (populating Requirement/SpecDocument/Task rows for the task graph and Progress/Tasks tabs); this new store exists purely so the Planner tab has one raw markdown document per stage to display, edit, and save.

The user also asked that edited content flow into the project's RAG chat, so an edit isn't invisible to the assistant until the next full regeneration.

## Backend changes (apps/cloud)

### New `stage_documents` store

A new table, independent of the graph schema:

```sql
create table pz_stage_documents (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id),
    project_id   uuid not null references pz_projects (id),
    stage        text not null check (stage in ('constitution','specify','plan','tasks')),
    content      text not null default '',
    created_by   uuid,
    updated_at   timestamptz not null default now(),
    unique (project_id, stage)
);
```

Pydantic model `StageDocument{id, workspace_id, project_id, stage, content, created_by, updated_at}` in `app/models/schemas.py`. Repo methods `get_stage_document(project_id, stage)` / `upsert_stage_document(project_id, stage, content, user_id)`, implemented in both `InMemoryRepository` and the Supabase repo, following the existing dual-backend pattern (e.g. `get_latest_spec_document`).

### Routes

New `app/api/stage_documents.py`, mounted alongside `documents`:

- `GET /projects/{project_id}/stage-documents/{stage}` — membership-scoped like other project routes; 404 → frontend treats as empty content, not an error state.
- `PATCH /projects/{project_id}/stage-documents/{stage}` — body `{content: str}`; upserts, sets `updated_at`, then calls `enqueue(app, EmbedJob(workspace_id, project_id, "stage_documents", stage_document.id))` (see RAG below). Conflict policy is last-write-wins by `updated_at`, matching the existing sync ADR 0010 policy elsewhere in the codebase — no optimistic-lock version check.

### Auto-save on generation

`app/api/generation.py::generate()` — after a stage's SSE stream completes and `parse_stage_output()` runs (i.e. after the existing `_persist_requirement` / `_persist_spec_document` / `_persist_tasks` calls, unchanged), also call `upsert_stage_document(project_id, stage, result.content, user_id)` and enqueue its `EmbedJob`. This means the raw markdown is durable and RAG-indexed immediately after the first generation, before any manual edit — the PATCH route is only needed when a user subsequently edits it.

### RAG wiring

`app/rag/source.py`: add `"stage_documents"` to `RAG_NODE_TYPES` and to `node_text()` (returns `content` directly — already full markdown, no field concatenation needed). This is the only RAG-side change; `pz_rag_chunks.node_id` already stores an opaque UUID per `node_type`, so no schema change is needed there. `reindex_project` (`assistant.py`) should also sweep `stage_documents` in its bulk-backfill loop, for consistency with the other four node types it already covers.

No change to `Requirement`/`SpecDocument`/`Task` schemas or to `parse_stage_output`'s existing graph-entity logic.

## Frontend changes (apps/web)

### `react-markdown` dependency

Add to `apps/web/package.json`. No other markdown lib needed — no GFM tables/footnotes requirement was raised, so the base renderer is sufficient; can add `remark-gfm` later if a stage document needs it.

### New reusable component: `apps/web/src/components/ui/MarkdownEditor.tsx`

First component under a new `components/ui/` directory (doesn't exist yet — this is the seed for future shared components, matching the project's stated goal of reuse/consistency). Named export, `"use client"`, Tailwind, with a sibling `MarkdownEditor.test.tsx`.

```tsx
type MarkdownEditorProps = {
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving?: boolean;
  error?: string | null;
};
```

- Two-tab header, "Raw" | "Preview", local `useState<"raw" | "preview">`.
- Raw tab: `<textarea>` bound to `value`/`onChange`, monospace, matching existing `StageSection` textarea styling.
- Preview tab: `<ReactMarkdown>{value}</ReactMarkdown>`.
- Save button: disabled while `saving`, calls `onSave`. No autosave — explicit save keeps the PATCH/embed-job volume predictable and matches the "Generate" button's existing explicit-action pattern in `StageSection`.
- `error`, if set, renders as an inline banner above the tabs (matches the 429/error-banner pattern already used for generation errors).

The component owns no fetch logic itself — value/onChange/onSave are all controlled by the parent, so it has zero knowledge of stages, projects, or the API. This is what makes it reusable elsewhere (e.g. a future PRD-content viewer) without modification.

### `lib/api.ts`

Add `getStageDocument(projectId, stage, authHeaders)` (GET, treats 404 as `{content: ""}`) and `updateStageDocument(projectId, stage, content, authHeaders)` (PATCH).

### `Planner.tsx` / `StageSection`

- On mount, `getStageDocument` hydrates a new `docContent` state; while loading, show the existing streaming/empty UI unchanged.
- The `<pre>` block is replaced by `MarkdownEditor` bound to `docContent`, `onSave` calling `updateStageDocument`.
- After a generation stream completes, set `docContent` to the freshly generated text (already persisted server-side by the auto-save above, so no immediate PATCH is needed on the frontend's part — the next explicit Save only fires if the user then edits it further).
- Loading/saving states surface through the same `error`/`saving` props `MarkdownEditor` exposes.

## Error handling

- GET 404 (no stage document yet) → empty editor, no visible error.
- PATCH failure (network, 4xx/5xx) → inline banner in `MarkdownEditor`, edited content stays in the textarea (never discarded on save failure).
- Embed-job enqueue failure is fire-and-forget from the route's perspective (matches existing `enqueue()` call sites, which don't roll back the PATCH if embedding fails) — a failed embed just means the edit isn't searchable in RAG chat yet, not that the save itself failed.

## Testing

- **Cloud** (`pytest`): roundtrip GET → PATCH → GET on `stage_documents`; 404-empty case; membership-scoping negative test (non-member gets 403/404); generation auto-save creates a fetchable stage document; PATCH enqueues an `EmbedJob` with `node_type="stage_documents"`.
- **Web** (`vitest`): `MarkdownEditor` — tab toggle renders textarea vs. rendered markdown, `onChange` fires on typing, `onSave` fires on button click and respects `saving`/`error` props. `Planner.test.tsx` — hydrates `MarkdownEditor` from a mocked `getStageDocument` response, calls `updateStageDocument` on save.

## Out of scope

- GFM extensions (tables, strikethrough, task lists) in the markdown renderer — add `remark-gfm` later if a real stage document needs it.
- Optimistic-lock / conflict UI beyond last-write-wins — matches existing sync policy, not a regression.
- Migrating `constitution`'s existing "never persisted to the graph" status — this design gives it a home in `stage_documents` for the first time, but does not add it to any graph-entity flow; that remains future work if `constitution` needs to participate in the task graph.
