-- PromptZone Cloud — initial schema (task graph)
-- Apply in the Supabase SQL editor or via `psql`. Table names are prefixed pz_.
--
-- Privacy note: model CREDENTIALS are never stored in the cloud. There is no
-- api_key / token column anywhere here by design.

create extension if not exists "pgcrypto";

-- Projects -------------------------------------------------------------------
create table if not exists pz_projects (
    id                uuid primary key default gen_random_uuid(),
    name              text not null,
    owner_id          text not null,
    onboarding_state  text not null default 'not_started',
    stage_state       jsonb not null default
                        '{"scope":"active","spec":"locked","skill":"locked"}'::jsonb,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);
create index if not exists idx_pz_projects_owner on pz_projects (owner_id);

-- Requirements (from Scope) --------------------------------------------------
create table if not exists pz_requirements (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references pz_projects (id) on delete cascade,
    title        text not null,
    description  text not null default '',
    status       text not null default 'draft',
    updated_at   timestamptz not null default now()
);
create index if not exists idx_pz_requirements_project on pz_requirements (project_id);
create index if not exists idx_pz_requirements_updated on pz_requirements (project_id, updated_at);

-- Spec documents (from Spec / plan) ------------------------------------------
create table if not exists pz_spec_documents (
    id              uuid primary key default gen_random_uuid(),
    project_id      uuid not null references pz_projects (id) on delete cascade,
    requirement_id  uuid not null references pz_requirements (id) on delete cascade,
    content         text not null default '',
    version         integer not null default 1,
    status          text not null default 'draft',
    approved_by     text,
    updated_at      timestamptz not null default now()
);
create index if not exists idx_pz_specs_project on pz_spec_documents (project_id);
create index if not exists idx_pz_specs_updated on pz_spec_documents (project_id, updated_at);

-- Tasks ----------------------------------------------------------------------
create table if not exists pz_tasks (
    id                   uuid primary key default gen_random_uuid(),
    project_id           uuid not null references pz_projects (id) on delete cascade,
    spec_id              uuid references pz_spec_documents (id) on delete set null,
    title                text not null,
    status               text not null default 'todo',
    feature_tag          text,
    -- {text: string}[] to match the Ideva Kit card renderer. Do not flatten.
    acceptance_criteria  jsonb not null default '[]'::jsonb,
    updated_at           timestamptz not null default now()
);
create index if not exists idx_pz_tasks_project on pz_tasks (project_id);
create index if not exists idx_pz_tasks_updated on pz_tasks (project_id, updated_at);

-- Artifacts (generated code / PRs / docs) ------------------------------------
create table if not exists pz_artifacts (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references pz_projects (id) on delete cascade,
    task_id      uuid not null references pz_tasks (id) on delete cascade,
    kind         text not null default 'code',
    uri          text not null,
    commit_sha   text,
    updated_at   timestamptz not null default now()
);
create index if not exists idx_pz_artifacts_project on pz_artifacts (project_id);
create index if not exists idx_pz_artifacts_updated on pz_artifacts (project_id, updated_at);

-- Agent runs (which model did what) ------------------------------------------
create table if not exists pz_agent_runs (
    id           uuid primary key default gen_random_uuid(),
    project_id   uuid not null references pz_projects (id) on delete cascade,
    task_id      uuid not null references pz_tasks (id) on delete cascade,
    model_role   text not null default 'code',
    action       text not null default '',
    status       text not null default 'running',
    evidence     jsonb not null default '{}'::jsonb,
    updated_at   timestamptz not null default now()
);
create index if not exists idx_pz_agent_runs_project on pz_agent_runs (project_id);
create index if not exists idx_pz_agent_runs_updated on pz_agent_runs (project_id, updated_at);

-- NOTE: Row Level Security is intentionally deferred to the auth milestone.
-- When Supabase Auth lands, enable RLS on every table and scope rows by
-- owner_id / project membership.
