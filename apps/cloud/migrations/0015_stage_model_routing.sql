-- PromptConnext Cloud — Milestone 3 (plan 0007): stage routing table.
--
-- Overrides the hard-coded default (constitution/specify/tasks -> managed,
-- plan -> byo — see app/generation/routing.py::DEFAULT_STAGE_ROUTING,
-- removed 2026-07-25, see ADR 0013's update note) per
-- workspace (project_id null) or per project (project_id set). Resolution
-- order is project -> workspace -> default; app/generation/routing.py owns
-- that logic, this table only stores the overrides that exist.
--
-- project_id is nullable and NULLs are never equal to each other in a
-- Postgres unique constraint, so a naive UNIQUE(workspace_id, project_id,
-- stage) would silently allow duplicate workspace-level rows (project_id
-- IS NULL) for the same stage. app/db/repository.py's upsert deletes any
-- existing matching row before inserting instead of relying on ON CONFLICT,
-- so no unique constraint is declared here — just an index for lookups.
create table if not exists pz_stage_model_routing (
    id           uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id) on delete cascade,
    project_id   uuid references pz_projects (id) on delete cascade,
    stage        text not null,  -- 'constitution' | 'specify' | 'plan' | 'tasks'
    model_source text not null,  -- 'byo' | 'managed'
    model        text,           -- optional specific model name override
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists idx_pz_stage_model_routing_lookup
  on pz_stage_model_routing (workspace_id, project_id, stage);

alter table pz_stage_model_routing enable row level security;

drop policy if exists pz_stage_model_routing_read on pz_stage_model_routing;
create policy pz_stage_model_routing_read on pz_stage_model_routing
  for select using (pz_is_member(workspace_id));
drop policy if exists pz_stage_model_routing_write on pz_stage_model_routing;
create policy pz_stage_model_routing_write on pz_stage_model_routing
  for all using (pz_is_admin(workspace_id)) with check (pz_is_admin(workspace_id));

grant select, insert, update, delete on pz_stage_model_routing to authenticated;
