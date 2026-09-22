-- 0031 — the seven graph tables become service-only: the server is the only
-- writer (docs/plans/0014-row-level-security-parity.md, Option A, decided
-- 2026-09-13; finding 2 of docs/cloud-codebase-review-2026-09-06.md).
--
-- >>> APPLY THIS ONE *AFTER* THE CODE DEPLOY, NOT BEFORE. <<<
-- It is the exception to the rule in docs/DEPLOYMENT.md §6 ("keep applying
-- migrations before deploying code that needs them"), and §2.2 documents the
-- exception. Every other migration in this directory adds or widens something,
-- so old code keeps working across the gap; this one takes privileges away
-- from the role the *old* code writes as. app/dependencies.py::get_repository
-- hands every auth_mode="supabase" request a repository scoped to the caller's
-- own JWT (SupabaseRepository.for_user), so before the paired code change,
-- production graph reads and writes execute as `authenticated`. Apply this
-- while that code is still live and every one of them fails with `permission
-- denied for table ...` until the rollout finishes.
--
-- The paired code change routes all seven tables onto the service-role client
-- (app/db/supabase_repository.py's _SERVICE_ONLY_TABLES / _table). Once it is
-- live, this migration is invisible to the application: the server never
-- reaches these tables as `authenticated` again. 0030 has already guaranteed
-- `service_role` holds the grants that client needs.
--
-- THE DEFECT
-- app/api/_guards.py enforces rules the database never did: admin-only
-- authoring of the `constitution`/`plan` stages (ADMIN_ONLY_STAGES), task
-- ownership on reassignment (app/api/sync.py::assign_task), admin-only
-- `verified` (app/api/sync.py::set_task_status), and — plan 0015's additions —
-- that a comment is an attributed statement nobody may post as somebody else
-- or overwrite (discussion_author_forbidden / discussion_forbidden). Every
-- policy governing these tables tests workspace membership and nothing else:
-- `pz_is_member` in 0003_auth_workspaces.sql's graph-table loop, in
-- 0011_discussions.sql, and in 0019_stage_documents.sql — while those same
-- migrations handed `authenticated` select/insert/update/delete outright. A
-- signed-in member who took their own Supabase JWT to the PostgREST data API
-- therefore wrote whatever the API would have refused, because the API was
-- never in that path. Measured, not assumed:
-- tests/rls/test_graph_table_grants.py drove exactly that with two real Auth
-- users against a real local stack, and every probe landed (200/201) before
-- this migration.
--
-- BASELINE THIS REPLACES (information_schema.role_table_grants, all seven
-- tables, on a database with 0001-0030 applied):
--   authenticated -> DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   anon          -> REFERENCES, TRIGGER, TRUNCATE
-- and pg_policies: one `*_rw` ALL policy per graph table whose USING and WITH
-- CHECK are both `pz_is_member(<the project's workspace>)`, plus
-- pz_stage_documents_read (SELECT) and pz_stage_documents_write (ALL), both
-- `pz_is_member(workspace_id)`. After this migration `authenticated` and
-- `anon` hold nothing on these seven.
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
-- pz_discussions is in this set for the same reason as the other six, and was
-- missed on the first pass. It is in ENTITY_TYPES, it is written through the
-- same code path, and plan 0015's two discussion rules are API-only — so a
-- member could POST or PATCH pz_discussions directly and forge or overwrite
-- another member's comment, which is the same bypass class in a table the
-- plan's matrix did not enumerate. No new authorization rule is needed; the
-- guards already exist. Only the grant was missing.
--
-- THE POLICIES STAY, deliberately unmodified. Postgres checks the base GRANT
-- before RLS ever runs (the ordering 0006_grants.sql's own comment explains),
-- so with the grant gone the `pz_is_member`-only policies are unreachable
-- rather than misleading. Removing them would be a second, independent change
-- to review; leaving them costs nothing and keeps the diff honest.

revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents,
  pz_discussions
from authenticated;

revoke all on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents,
  pz_discussions
from anon;

-- Future graph tables do NOT inherit this posture: 0006_grants.sql's
-- `alter default privileges ... to authenticated` is still in force, so an
-- eighth graph table created later is born with the grant this migration
-- exists to remove — which is exactly how pz_discussions and
-- pz_stage_documents acquired theirs. Narrowing that default is a broader
-- change than plan 0014 scoped (it governs every table this app creates,
-- graph or not), so it is left alone and flagged here rather than silently
-- half-done. A new graph table needs adding to _SERVICE_ONLY_TABLES and to a
-- revoke of its own.
