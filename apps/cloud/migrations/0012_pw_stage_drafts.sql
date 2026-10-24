-- 0012_pw_stage_drafts — agent-written planning drafts and provenance
-- (design 2026-10-24-local-agent-brownfield-planning). Idempotent.
-- Service-only like pw_repo_analyses: every rule lives in app/api/stage_drafts.py.
-- DEPLOY ORDER: apply BEFORE deploying this code (the adapter inserts `source`).
alter table pw_repo_analyses add column if not exists source text not null default 'cloud';
alter table pw_repo_analyses add column if not exists model text;
alter table pw_stage_documents add column if not exists source text;

create table if not exists pw_stage_drafts (
    id uuid primary key,
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null,
    stage text not null check (stage in ('constitution','specify','plan','tasks')),
    markdown text not null,
    source text not null default 'agent',
    model text,
    status text not null default 'pending' check (status in ('pending','rejected')),
    rejection_note text,
    last_error text,
    predecessor_fingerprint text,
    created_by uuid not null,
    created_at timestamptz not null default now(),
    unique (project_id, stage)
);
alter table pw_stage_drafts enable row level security;
revoke all on pw_stage_drafts from authenticated;
revoke all on pw_stage_drafts from anon;
grant select, insert, update, delete on pw_stage_drafts to service_role;
