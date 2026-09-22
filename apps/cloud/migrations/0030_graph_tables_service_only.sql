-- 0030 — the six graph tables become service-only: the server is the only
-- writer (docs/plans/0014-row-level-security-parity.md, Option A, decided
-- 2026-09-13; finding 2 of docs/cloud-codebase-review-2026-09-06.md).
--
-- THE DEFECT
-- app/api/_guards.py enforces three rules the database never did: admin-only
-- authoring of the `constitution`/`plan` stages (ADMIN_ONLY_STAGES), task
-- ownership on reassignment (app/api/sync.py::assign_task), and admin-only
-- `verified` (app/api/sync.py::set_task_status, 403 verified_requires_admin).
-- Every policy governing these tables tests workspace membership and nothing
-- else — `pz_is_member` in 0003_auth_workspaces.sql's graph-table loop and in
-- 0019_stage_documents.sql — while 0006_grants.sql handed `authenticated`
-- select/insert/update/delete outright. A signed-in member who took their own
-- Supabase JWT to the PostgREST data API therefore wrote whatever the API
-- would have refused, because the API was never in that path. Measured, not
-- assumed: tests/rls/test_graph_table_grants.py drove exactly that with two
-- real Auth users against a real local stack and all three writes landed
-- (200/201) before this migration.
--
-- BASELINE THIS REPLACES (information_schema.role_table_grants, all six
-- tables, on a database with 0001-0029 applied):
--   authenticated -> DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   anon          -> REFERENCES, TRIGGER, TRUNCATE
-- and pg_policies: one `*_rw` ALL policy per graph table whose USING and WITH
-- CHECK are both `pz_is_member(<the project's workspace>)`, plus
-- pz_stage_documents_read (SELECT) and pz_stage_documents_write (ALL), both
-- `pz_is_member(workspace_id)`. After this migration `authenticated` and
-- `anon` hold nothing on these six, and `service_role` holds the four DML
-- privileges.
--
-- WHY REVOKE RATHER THAN ADD POLICIES (Option B, rejected)
-- The rules are already duplicated once, between app/models/schemas.py's
-- FIELD_AUTHORITY/ADMIN_ONLY_STAGES and apps/web/src/lib/fieldAuthority.ts. A
-- third copy in SQL could not share sync.py's self-assign/self-unassign
-- branching without re-deriving it, and would drift silently the next time a
-- rule changed in Python only. Nothing loses a capability it uses: no client
-- reads or writes these tables over the data API — apps/web's only use of
-- @supabase/supabase-js is auth.getSession()/onAuthStateChange() in
-- src/lib/auth.tsx, and every graph read and write goes through apiFetch
-- against apps/cloud.
--
-- Precedent for the shape: 0020_repo_webhooks.sql ("there is nothing here a
-- member needs") and 0021_repo_webhooks_anon_revoke.sql, which closes the
-- same table's `anon` grant so the grant and the intent agree.
--
-- THE POLICIES STAY, deliberately unmodified. Postgres checks the base GRANT
-- before RLS ever runs (the ordering 0006_grants.sql's own comment explains),
-- so with the grant gone the `pz_is_member`-only policies are unreachable
-- rather than misleading. Removing them would be a second, independent
-- change to review; leaving them costs nothing and keeps the diff honest.
--
-- THIS MIGRATION MUST DEPLOY WITH ITS CODE CHANGE, NOT AHEAD OF IT.
-- app/dependencies.py::get_repository hands every auth_mode="supabase"
-- request a repository scoped to the caller's own JWT (SupabaseRepository
-- .for_user), so before that change production graph writes really did
-- execute as `authenticated`. The same commit routes every call against these
-- six tables onto the service-role client instead
-- (SupabaseRepository._table's _SERVICE_ONLY_TABLES split); shipping the
-- revoke without it fails every such write with `permission denied for table
-- ...`.

revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents
from authenticated;

revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents
from anon;

-- The other half of "the server is the only writer": say so for the role the
-- server actually uses, rather than relying on a platform default. This is
-- not belt-and-braces. Supabase no longer auto-exposes tables created by a
-- migration to the Data API roles — supabase/config.toml's
-- `auto_expose_new_tables` is unset, "matching the new cloud default" — and
-- 0006_grants.sql's `alter default privileges` names only `authenticated`.
-- On a local `supabase start` with 0001-0029 applied, `service_role` holds no
-- DML on any pz_ table at all; that is why tests/contract/conftest.py's setup
-- recipe has to grant it by hand. Taking the grant away from `authenticated`
-- while the server's own role depends on an implicit default would turn one
-- platform change into a total write outage, which is the precise failure
-- this plan warned against. `service_role` bypasses RLS and keeps its grants
-- (0021's note), so this grants privileges it is already meant to have; it is
-- idempotent on any project that already has them.
grant select, insert, update, delete on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents
to service_role;

-- Future graph tables do NOT inherit this posture: 0006_grants.sql's
-- `alter default privileges ... to authenticated` is still in force, so a
-- seventh graph table created later is born with the grant this migration
-- exists to remove. Narrowing that default is a broader change than plan 0014
-- scoped (it governs every table this app creates, graph or not), so it is
-- left alone and flagged here instead of silently half-done.
