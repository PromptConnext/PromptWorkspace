-- PromptConnext Cloud — stage_documents: raw-markdown side store for
-- Planner stages (constitution/specify/plan/tasks), independent of the
-- graph-entity persistence (Requirement/SpecDocument/Task). Lets the
-- Planner tab show a Raw|Preview editor with edits that survive reload and
-- feed into RAG chat (docs/superpowers/specs/2026-07-26-planner-markdown-
-- editor-design.md). One row per (project_id, stage) — a fresh generation
-- or a manual edit overwrites the existing row for that stage, no history.

create table if not exists pz_stage_documents (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id),
    project_id uuid not null references pz_projects (id),
    stage text not null check (stage in ('constitution', 'specify', 'plan', 'tasks')),
    content text not null default '',
    created_by uuid,
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    unique (project_id, stage)
);

create index if not exists idx_pz_stage_documents_scope on pz_stage_documents (workspace_id, project_id) where deleted_at is null;

alter table pz_stage_documents enable row level security;

drop policy if exists pz_stage_documents_read on pz_stage_documents;
create policy pz_stage_documents_read on pz_stage_documents
  for select using (pz_is_member(workspace_id));
drop policy if exists pz_stage_documents_write on pz_stage_documents;
create policy pz_stage_documents_write on pz_stage_documents
  for all using (pz_is_member(workspace_id)) with check (pz_is_member(workspace_id));

grant select, insert, update, delete on pz_stage_documents to authenticated;
