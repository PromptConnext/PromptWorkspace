-- PromptZone Cloud — Milestone 9: RAG assistant v1 (plan 0005, ADR 0011)
--
-- v1 embeds only requirements, spec_documents, and tasks (the entities that
-- already carry free text) — no Discussion entity or Artifact content exist
-- yet, so those v1-plan sources are deferred, not silently expanded here.
create extension if not exists vector;

-- Workspace-BYO model connection (chat + embedding). secret_ref is opaque
-- ciphertext produced by app/secrets.py (Fernet, key = RAG_KEY_ENCRYPTION_KEY
-- env var, never in Postgres) — the API never serializes this column back to
-- any client, and no plaintext key material is ever written here.
create table if not exists pz_workspace_model_connections (
    workspace_id       uuid primary key references pz_workspaces (id) on delete cascade,
    provider           text not null,          -- descriptive only: 'openai' | 'ollama' | ...
    base_url           text not null,          -- OpenAI-compatible endpoint the key is BYO for
    model              text not null,          -- chat model
    embed_model        text not null,
    embed_dim          integer not null default 1536,
    secret_ref         text not null,
    daily_token_budget integer not null default 200000,
    created_by         uuid not null,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

alter table pz_workspace_model_connections enable row level security;

drop policy if exists pz_wmc_read on pz_workspace_model_connections;
create policy pz_wmc_read on pz_workspace_model_connections
  for select using (pz_is_member(workspace_id));
drop policy if exists pz_wmc_write on pz_workspace_model_connections;
create policy pz_wmc_write on pz_workspace_model_connections
  for all using (pz_is_admin(workspace_id)) with check (pz_is_admin(workspace_id));

-- Chunked, embedded artifact text. Written by the background embed worker via
-- the service-role repository (bypasses RLS like the rest of the sync path);
-- RLS here is member-read defense-in-depth, mirroring pz_tasks etc.
create table if not exists pz_rag_chunks (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id) on delete cascade,
    project_id   uuid not null references pz_projects (id) on delete cascade,
    node_type    text not null,      -- 'requirements' | 'spec_documents' | 'tasks'
    node_id      uuid not null,
    chunk_index  integer not null,
    content      text not null,
    embedding    vector(1536) not null,
    updated_at   timestamptz not null default now(),
    unique (node_id, chunk_index)
);

create index if not exists idx_pz_rag_chunks_scope on pz_rag_chunks (workspace_id, project_id);
create index if not exists idx_pz_rag_chunks_embedding
  on pz_rag_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table pz_rag_chunks enable row level security;

drop policy if exists pz_rag_chunks_read on pz_rag_chunks;
create policy pz_rag_chunks_read on pz_rag_chunks
  for select using (pz_is_member(workspace_id));

grant select, insert, update, delete on
  pz_workspace_model_connections, pz_rag_chunks
to authenticated;

-- Retrieval RPC: membership scoping happens at the app layer (require_project
-- gates the caller to a workspace they belong to) *and* here via the explicit
-- workspace_id/project_id predicate — nearest-neighbour search never runs
-- unscoped, per ADR 0011 ("Retrieval is membership-scoped before similarity").
-- Plain (invoker) security: PostgREST calls made with the caller's JWT still
-- go through pz_rag_chunks_read as a second, independent layer.
create or replace function pz_rag_match_chunks(
    p_workspace_id uuid,
    p_project_id uuid,
    p_query_embedding vector(1536),
    p_match_count integer default 8
) returns table (
    node_type text,
    node_id uuid,
    chunk_index integer,
    content text,
    score float
)
language sql stable set search_path = public as $$
  select node_type, node_id, chunk_index, content,
         1 - (embedding <=> p_query_embedding) as score
  from pz_rag_chunks
  where workspace_id = p_workspace_id and project_id = p_project_id
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function pz_rag_match_chunks(uuid, uuid, vector, integer) to authenticated;
