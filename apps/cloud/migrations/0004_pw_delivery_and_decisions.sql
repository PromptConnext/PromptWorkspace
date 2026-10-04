-- 0004_pw_delivery_and_decisions — plan 0029 M1 + M2.
--
-- THE PROBLEM
-- Generated tasks were one flat list assigned to people, and the approval
-- fields on requirements and spec documents were never written. Plan 0029
-- groups tasks into PR-sized Changes and records approvals as decisions.
--
-- SHAPE
-- pw_delivery_changes: one row per `## Phase N:` section of tasks.md. `key`
--   is what a regeneration matches on; `ref` ("C3") is assigned once.
--   Retired rows keep their ref (deleted_at set) so a returning phase revives.
-- pw_tasks.change_id: the change a task belongs to (nullable; null for tasks
--   generated before this migration or whose phase could not be stored).
-- pw_project_roles: one user per hat per project (business_owner,
--   tech_steward). No row means "workspace admins act for this hat".
-- pw_decisions: approval requests bound to a SHA-256 of the stage document
--   they approve, so an edit after approval reads as stale.
--
-- GRANTS
-- Service-only from birth, like pw_stage_inputs (0003): the baseline's
-- default privileges would otherwise hand a new table to `authenticated`.
-- Every rule lives in the API (app/api/delivery.py).
--
-- DEPLOY ORDER
-- Apply BEFORE deploying code that writes Task.change_id: the Supabase
-- adapter dumps every Task field on upsert, so task generation fails until
-- the column exists. Reads of the three new tables tolerate their absence.

alter table pw_tasks add column if not exists change_id uuid;

create table if not exists pw_delivery_changes (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    ref text not null,
    key text not null,
    title text not null,
    kind text not null
        check (kind in ('setup', 'foundational', 'story', 'other', 'polish', 'unphased')),
    story integer,
    priority text,
    position integer not null,
    depends_on text[] not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,
    unique (project_id, key),
    unique (project_id, ref)
);
create index if not exists idx_pw_delivery_changes_project
    on pw_delivery_changes (project_id, position);

alter table pw_tasks
    add constraint pw_tasks_change_id_fkey
    foreign key (change_id) references pw_delivery_changes (id) on delete set null;

create table if not exists pw_project_roles (
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    hat text not null check (hat in ('business_owner', 'tech_steward')),
    user_id text not null,
    assigned_by text not null,
    created_at timestamptz not null default now(),
    primary key (project_id, hat)
);

create table if not exists pw_decisions (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    kind text not null check (kind in ('intent_approval', 'plan_approval')),
    title text not null,
    subject_stage text not null check (subject_stage in ('specify', 'tasks')),
    subject_hash text not null,
    routed_hat text not null check (routed_hat in ('business_owner', 'tech_steward')),
    status text not null default 'open'
        check (status in ('open', 'approved', 'rejected', 'withdrawn')),
    rationale text,
    requested_by text not null,
    resolved_by text,
    created_at timestamptz not null default now(),
    resolved_at timestamptz
);
create index if not exists idx_pw_decisions_project on pw_decisions (project_id, created_at desc);
create index if not exists idx_pw_decisions_open on pw_decisions (workspace_id) where status = 'open';

alter table pw_delivery_changes enable row level security;
alter table pw_project_roles enable row level security;
alter table pw_decisions enable row level security;

revoke all on pw_delivery_changes from authenticated;
revoke all on pw_delivery_changes from anon;
revoke all on pw_project_roles from authenticated;
revoke all on pw_project_roles from anon;
revoke all on pw_decisions from authenticated;
revoke all on pw_decisions from anon;
grant select, insert, update, delete on pw_delivery_changes to service_role;
grant select, insert, update, delete on pw_project_roles to service_role;
grant select, insert, update, delete on pw_decisions to service_role;
