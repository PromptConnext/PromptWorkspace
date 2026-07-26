-- PromptConnext Cloud — Milestone 1 (plan 0007): generation audit + cost
-- accounting. Not part of the task graph itself — the generated artifact
-- lands as a Requirement/SpecDocument/Task via the existing sync/upsert
-- path (app/api/generation.py); this table only records that a generation
-- happened, on what model, and how many tokens it spent.
create table if not exists pz_generation_runs (
    id                uuid primary key default gen_random_uuid(),
    workspace_id      uuid not null references pz_workspaces (id) on delete cascade,
    project_id        uuid not null references pz_projects (id) on delete cascade,
    stage             text not null,   -- 'constitution' | 'specify' | 'plan' | 'tasks'
    model_source      text not null default 'byo',  -- 'byo' | future: 'managed' (M2)
    model             text not null,
    status            text not null default 'running',  -- 'running' | 'succeeded' | 'failed'
    prompt_tokens     integer not null default 0,
    completion_tokens integer not null default 0,
    created_at        timestamptz not null default now()
);

create index if not exists idx_pz_generation_runs_scope on pz_generation_runs (workspace_id, project_id);

alter table pz_generation_runs enable row level security;

drop policy if exists pz_generation_runs_read on pz_generation_runs;
create policy pz_generation_runs_read on pz_generation_runs
  for select using (pz_is_member(workspace_id));

drop policy if exists pz_generation_runs_write on pz_generation_runs;
create policy pz_generation_runs_write on pz_generation_runs
  for insert with check (pz_is_member(workspace_id));

drop policy if exists pz_generation_runs_update on pz_generation_runs;
create policy pz_generation_runs_update on pz_generation_runs
  for update using (pz_is_member(workspace_id)) with check (pz_is_member(workspace_id));

grant select, insert, update, delete on pz_generation_runs to authenticated;
