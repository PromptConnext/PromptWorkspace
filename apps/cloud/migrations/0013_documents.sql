-- PromptConnext Cloud — Milestone 0 (plan 0007): project knowledge base.
--
-- Uploaded artifacts (PRD PDFs, Markdown) become a first-class `documents`
-- graph node, riding the same RAG rails as every other node_type (M9):
-- extracted text is chunked + embedded into pz_rag_chunks once extraction
-- succeeds. Unlike code_file (M11), extracted text IS persisted here — these
-- are business documents, not source code, so ADR 0011's "no source at rest"
-- rule doesn't apply.
create table if not exists pz_documents (
    id             uuid primary key default gen_random_uuid(),
    workspace_id   uuid not null references pz_workspaces (id) on delete cascade,
    project_id     uuid not null references pz_projects (id) on delete cascade,
    title          text not null,
    mime           text not null,
    storage_ref    text not null,      -- opaque path into Supabase Storage
    source_kind    text not null default 'upload',  -- 'upload' | future: 'figma-mcp'
    extract_method text,               -- 'passthrough' | 'text_layer' | 'ocr', null until extracted
    status         text not null default 'pending',  -- 'pending' | 'extracted' | 'failed'
    extracted_text text,
    created_by     uuid not null,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    deleted_at     timestamptz
);

create index if not exists idx_pz_documents_scope on pz_documents (workspace_id, project_id);

alter table pz_documents enable row level security;

drop policy if exists pz_documents_read on pz_documents;
create policy pz_documents_read on pz_documents
  for select using (pz_is_member(workspace_id));
drop policy if exists pz_documents_write on pz_documents;
create policy pz_documents_write on pz_documents
  for all using (pz_is_member(workspace_id)) with check (pz_is_member(workspace_id));

grant select, insert, update, delete on pz_documents to authenticated;

comment on column pz_rag_chunks.node_type is
  'requirements | spec_documents | tasks | pull_requests | discussions | documents';

-- Supabase Storage: one bucket for uploaded document originals, RLS-scoped by
-- the same membership function used everywhere else. Objects are stored
-- under `<workspace_id>/<document_id>/<filename>` so the workspace segment of
-- the path can be checked directly in the policy without a table join.
insert into storage.buckets (id, name, public)
  values ('pz-documents', 'pz-documents', false)
  on conflict (id) do nothing;

drop policy if exists pz_documents_storage_read on storage.objects;
create policy pz_documents_storage_read on storage.objects
  for select using (
    bucket_id = 'pz-documents'
    and pz_is_member((storage.foldername(name))[1]::uuid)
  );

drop policy if exists pz_documents_storage_write on storage.objects;
create policy pz_documents_storage_write on storage.objects
  for insert with check (
    bucket_id = 'pz-documents'
    and pz_is_member((storage.foldername(name))[1]::uuid)
  );
