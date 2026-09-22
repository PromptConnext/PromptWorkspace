-- 0030 — name the server's own role on the graph tables, before anything
-- depends on it (docs/plans/0014-row-level-security-parity.md, Option A).
--
-- This is the FIRST of a deliberate pair. It only ever *adds* a privilege, to
-- one role, and that role already bypasses RLS — so it is safe to apply at any
-- time, in any order, against a database running any version of the code. It
-- breaks nothing, old or new. Its partner, 0031_graph_tables_revoke_client_
-- access.sql, takes privileges away and is the one with a deploy-ordering
-- constraint; see that file and docs/DEPLOYMENT.md §2.2.
--
-- WHY THIS IS NOT BELT-AND-BRACES
-- Plan 0014 moves every write to these tables onto the server's service-role
-- client. That makes `service_role`'s grant load-bearing where it previously
-- was not — and it cannot be taken for granted. Supabase no longer exposes
-- tables created by a migration to the Data API roles automatically
-- (supabase/config.toml's `auto_expose_new_tables`, unset, "matching the new
-- cloud default"), and 0006_grants.sql's `alter default privileges` names only
-- `authenticated`. Measured, not assumed: on a local `supabase start` with
-- 0001-0029 applied, `service_role` holds no DML on any pz_ table at all,
-- which is why tests/contract/conftest.py's setup recipe has to grant it by
-- hand. A production database very probably does have these grants — the
-- tombstone GC loop and the inbound webhook routes already write graph tables
-- on the service key and would be failing otherwise — but "very probably" is
-- not a basis for removing the other roles' access. Applying this first turns
-- that assumption into a fact before 0031 depends on it.
--
-- Idempotent, and a no-op in observable behaviour on any database that already
-- has these grants.

grant select, insert, update, delete on
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_stage_documents,
  pz_discussions
to service_role;
