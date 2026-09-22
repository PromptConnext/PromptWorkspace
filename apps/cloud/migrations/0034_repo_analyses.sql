-- 0034 — what the platform read out of an imported repository
-- (docs/plans/0027-brownfield-repo-import.md M1).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- One row per project, the *current* analysis: a re-analysis replaces it, and
-- nothing reads an older one. `snapshot` is the deterministic read
-- (app/imports/snapshot.py) — tree summary, detected stack, excerpts of a
-- fixed list of files — and `baseline` is the one model-written document over
-- it, which the Planner's plan and tasks stages are gated on for an imported
-- project (app/api/generation.py). The baseline is stored rather than
-- recomputed because it cost the workspace's daily token budget (ADR 0027).
--
-- Not a stage document: pz_stage_documents.stage is a closed CHECK on
-- purpose, and the baseline is an input to planning, not a Spec Kit stage.
--
-- Secret-shaped files are filtered out before the snapshot is built, so no
-- credential reaches `snapshot`. The content that does reach it is still a
-- customer's source excerpts, which is why the table is service-only below.

create table if not exists pz_repo_analyses (
    project_id uuid primary key references pz_projects (id) on delete cascade,
    workspace_id uuid not null references pz_workspaces (id) on delete cascade,
    commit_sha text not null,
    snapshot jsonb not null default '{}'::jsonb,
    baseline text not null default '',
    status text not null default 'snapshot_ready',
    created_by uuid,
    updated_at timestamptz not null default now()
);

alter table pz_repo_analyses
  drop constraint if exists pz_repo_analyses_status_check;
alter table pz_repo_analyses
  add constraint pz_repo_analyses_status_check
  check (status in ('snapshot_ready', 'baseline_ready', 'failed'));

alter table pz_repo_analyses enable row level security;

-- Service-only from birth, the posture 0031 gave the seven graph tables after
-- the fact. 0006_grants.sql's `alter default privileges ... to authenticated`
-- is still in force, so this table is born with a member grant that the
-- revokes below take straight back: the only enforcement of "admin-only
-- analysis, admin-only baseline edit" is app/api/repo_analysis.py, and a
-- member holding a direct grant here would walk around it. No client reads
-- this table over the data API; apps/web reads it through apps/cloud.
revoke all on pz_repo_analyses from authenticated;
revoke all on pz_repo_analyses from anon;
grant select, insert, update, delete on pz_repo_analyses to service_role;
