-- PromptZone Cloud — Milestone 11: Git-host integration (plan 0005, ADR 0011)
--
-- Two tables, two very different data classes:
--   * pz_pull_requests — PR title/description, real text. ADR 0011 names
--     this an indexable v2 source explicitly (not source code).
--   * pz_code_chunks   — embeddings + (repo, path, sha, line range) ONLY.
--     No `content` column, by construction: code is fetched fresh from the
--     Git host at answer time and discarded (app/api/assistant.py), never
--     persisted here even transiently. This is the literal implementation
--     of "no source code at rest."
--
-- GitHub App credentials (app id, private key, webhook secret) live in the
-- server env (Settings.github_app_*), never in Postgres — same rule as
-- jira_api_token. Per-workspace config (installation_id, repo,
-- default_branch, project_id) is non-secret and lives on
-- pz_workspaces.integration_config->'github' (existing jsonb column, same
-- pattern the Jira/ClickUp integration already uses) — no new column or
-- table needed for it.

create table if not exists pz_pull_requests (
    id           text primary key,  -- deterministic: pr-{project_id}-{number}
    project_id   uuid not null references pz_projects (id) on delete cascade,
    number       integer not null,
    title        text not null,
    body         text not null default '',
    html_url     text not null,
    head_sha     text not null,
    task_id      uuid references pz_tasks (id) on delete set null,
    merged       boolean not null default false,
    deleted_at   timestamptz,
    updated_at   timestamptz not null default now(),
    unique (project_id, number)
);

create index if not exists idx_pz_pull_requests_project on pz_pull_requests (project_id);

alter table pz_pull_requests enable row level security;

drop policy if exists pz_pull_requests_read on pz_pull_requests;
create policy pz_pull_requests_read on pz_pull_requests
  for select using (
    exists (
      select 1 from pz_projects p
      where p.id = pz_pull_requests.project_id and pz_is_member(p.workspace_id)
    )
  );

create table if not exists pz_code_chunks (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id) on delete cascade,
    project_id   uuid not null references pz_projects (id) on delete cascade,
    repo         text not null,      -- "owner/name"
    path         text not null,
    sha          text not null,
    start_line   integer not null,
    end_line     integer not null,
    chunk_index  integer not null,
    embedding    vector(1536) not null,
    updated_at   timestamptz not null default now(),
    unique (project_id, repo, path, chunk_index)
);

create index if not exists idx_pz_code_chunks_scope on pz_code_chunks (workspace_id, project_id);
create index if not exists idx_pz_code_chunks_path on pz_code_chunks (project_id, repo, path);
create index if not exists idx_pz_code_chunks_embedding
  on pz_code_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table pz_code_chunks enable row level security;

drop policy if exists pz_code_chunks_read on pz_code_chunks;
create policy pz_code_chunks_read on pz_code_chunks
  for select using (pz_is_member(workspace_id));

grant select, insert, update, delete on pz_pull_requests, pz_code_chunks to authenticated;

-- Membership-scoped before similarity (ADR 0011), same shape as
-- pz_rag_match_chunks — the explicit workspace_id/project_id predicate runs
-- before the nearest-neighbour search, independent of RLS.
create or replace function pz_code_match_chunks(
    p_workspace_id uuid,
    p_project_id uuid,
    p_query_embedding vector(1536),
    p_match_count integer default 8
) returns table (
    repo text,
    path text,
    sha text,
    start_line integer,
    end_line integer,
    score float
)
language sql stable set search_path = public as $$
  select repo, path, sha, start_line, end_line,
         1 - (embedding <=> p_query_embedding) as score
  from pz_code_chunks
  where workspace_id = p_workspace_id and project_id = p_project_id
  order by embedding <=> p_query_embedding
  limit p_match_count;
$$;

grant execute on function pz_code_match_chunks(uuid, uuid, vector, integer) to authenticated;
