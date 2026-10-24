-- 0011_pw_workspace_governance — workspace overview, AI governance, display
-- names, and the artifact agent (plan 0033).
--
-- THE PROBLEM
-- A workspace has no single place to say which policy its AI work must
-- follow, no record of which role must sign off, and members appear only by
-- id. Artifacts do not record which agent produced them, and a generation run
-- cannot exist outside a project.
--
-- SHAPE
-- pw_workspace_governance: one row per workspace holding the policy scope
-- (selected policies plus free text), the hats required to approve, and
-- whether seeded rules are required. Written by workspace admins.
-- pw_projects.policy_scope_source: 'workspace' or 'project', default
-- 'project', so existing projects keep their own policy scope.
-- pw_artifacts.agent: the agent that produced an artifact, nullable.
-- pw_workspace_members.display_name: a human-readable name shown in place
-- of the raw member id, nullable.
-- pw_generation_runs.project_id becomes nullable so a run can belong to the
-- workspace rather than a single project.
-- pw_receipts.subject_type also accepts 'project_policy' so policy changes
-- are recorded in the receipt chain.
-- Idempotent: every statement can run twice. The subject_type check is
-- replaced by name, because Postgres named the inline check in 0007
-- pw_receipts_subject_type_check.
--
-- GRANTS
-- pw_workspace_governance is service-only, the same pattern as 0010's LINE
-- tables: RLS is enabled with no policy, and `authenticated`/`anon` lose the
-- default grants. The new columns on existing tables inherit their table's
-- grants and need nothing.
--
-- DEPLOY ORDER
-- Apply BEFORE deploying this code: the adapter reads and writes
-- pw_workspace_governance and the new columns, so those reads fail until this
-- migration is applied. Dropping the project_id NOT NULL constraint is
-- additive; old code that always sets project_id keeps working.

create table if not exists pw_workspace_governance (
    workspace_id uuid primary key references pw_workspaces (id) on delete cascade,
    policy_scope jsonb not null default '{"selected": [], "custom_text": ""}'::jsonb,
    required_hats text[] not null default '{business_owner,tech_steward}',
    require_seeded_rules boolean not null default true,
    updated_by uuid,
    updated_at timestamptz not null default now()
);
alter table pw_workspace_governance enable row level security;
revoke all on pw_workspace_governance from authenticated;
revoke all on pw_workspace_governance from anon;
grant select, insert, update, delete on pw_workspace_governance to service_role;

alter table pw_projects add column if not exists policy_scope_source text not null default 'project';
alter table pw_projects drop constraint if exists pw_projects_policy_scope_source_check;
alter table pw_projects add constraint pw_projects_policy_scope_source_check
    check (policy_scope_source in ('workspace', 'project'));

alter table pw_artifacts add column if not exists agent jsonb;
alter table pw_workspace_members add column if not exists display_name text;
alter table pw_generation_runs alter column project_id drop not null;

alter table pw_receipts drop constraint if exists pw_receipts_subject_type_check;
alter table pw_receipts add constraint pw_receipts_subject_type_check
    check (subject_type in ('decision', 'project_role', 'project_policy'));
