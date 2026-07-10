-- PromptZone Cloud — Milestone 1: tombstone soft-delete
-- Adds a nullable deleted_at column to every graph entity. A delete is just
-- an upsert that sets deleted_at (see docs/plans/0001-cloud-deletes-and-auth.md).
--
-- Semantics:
--   * Bootstrap pull (no `since`)  -> live rows only (deleted_at is null)
--   * Incremental pull (`since` set) -> everything changed, tombstones included
--
-- Additive and backward-compatible: old clients that never send deleted_at
-- keep working exactly as before.

alter table pz_requirements   add column if not exists deleted_at timestamptz;
alter table pz_spec_documents add column if not exists deleted_at timestamptz;
alter table pz_tasks          add column if not exists deleted_at timestamptz;
alter table pz_artifacts      add column if not exists deleted_at timestamptz;
alter table pz_agent_runs     add column if not exists deleted_at timestamptz;

-- Bootstrap pulls filter on (project_id, deleted_at is null); partial index
-- keeps that cheap without penalizing the incremental-pull index above.
create index if not exists idx_pz_requirements_live   on pz_requirements   (project_id) where deleted_at is null;
create index if not exists idx_pz_spec_documents_live on pz_spec_documents (project_id) where deleted_at is null;
create index if not exists idx_pz_tasks_live          on pz_tasks          (project_id) where deleted_at is null;
create index if not exists idx_pz_artifacts_live      on pz_artifacts      (project_id) where deleted_at is null;
create index if not exists idx_pz_agent_runs_live     on pz_agent_runs     (project_id) where deleted_at is null;

-- Tombstone GC: purge_expired_tombstones() runs on TOMBSTONE_TTL_DAYS from
-- app config; scoped to rows whose deleted_at is old enough that every
-- client has plausibly synced past them. Safe by construction — it only
-- ever removes rows that are already tombstoned (deleted_at not null).
