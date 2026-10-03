-- 0003 — Planner form answers, stored server-side
--
-- THE PROBLEM
-- The web Planner's Specify/Plan/Constitution forms kept their answers in the
-- browser's localStorage only. pw_stage_documents holds what a generation
-- produced, never what the author asked for, so on another device — or for a
-- teammate — the fields came back empty although the stage existed, and a
-- regeneration meant retyping everything.
--
-- WHY A TABLE OF ITS OWN, NOT A COLUMN ON pw_stage_documents
-- Answers are saved while the author types, before the first generation. A
-- column would need a document row to hang on, and an empty-content row is
-- read as "this stage has a document" by the Planner's done-state, RAG
-- backfill and repository seeding. A separate row keyed (project_id, stage)
-- leaves every one of those readers untouched.
--
-- SHAPE
--   inputs      — the form's answers, a flat {field key: answer} object.
--                 Bounded by the API (app/api/stage_inputs.py): at most 40
--                 keys, 20,000 characters per answer. Replaced wholesale on
--                 every save, never merged.
--   updated_by  — the member whose save this is.
--
-- GRANTS
-- Service-only from birth, like pw_repo_analyses: the default privileges
-- 0002_pw_baseline.sql section 0006_grants.sql set up still hand a new table
-- to `authenticated`, and the only enforcement of "constitution/plan answers
-- are admin-only" is app/api/_guards.py::require_stage_access. A member's
-- direct grant would walk around it. apps/web reads and writes this table
-- only through apps/cloud, on the service-role client
-- (app/db/supabase_repository.py::_SERVICE_ONLY_TABLES).
--
-- DEPLOY ORDER
-- Either. Code that reaches a database without this table reads empty
-- answers and refuses saves with 503 stage_inputs_unavailable.

create table if not exists pw_stage_inputs (
    project_id uuid not null references pw_projects (id) on delete cascade,
    workspace_id uuid not null references pw_workspaces (id) on delete cascade,
    stage text not null check (stage in ('constitution', 'specify', 'plan')),
    inputs jsonb not null default '{}'::jsonb check (jsonb_typeof(inputs) = 'object'),
    updated_by uuid,
    updated_at timestamptz not null default now(),
    primary key (project_id, stage)
);

alter table pw_stage_inputs enable row level security;

revoke all on pw_stage_inputs from authenticated;
revoke all on pw_stage_inputs from anon;
grant select, insert, update, delete on pw_stage_inputs to service_role;
