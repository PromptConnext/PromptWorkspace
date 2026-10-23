-- 0005 — name the server's role on every pw_ table
--
-- THE PROBLEM
-- The baseline (0002) grants table privileges to `authenticated` and, for the
-- service-only tables, to `service_role` — but the server also reaches the
-- other tables on the service-role client: the presence WebSocket reads
-- pw_projects and pw_workspace_members, repository creation and the inbound
-- GitHub webhook write pw_repo_webhooks, the RAG queue reads model
-- connections and writes chunks, the deployment reconciler reads deployments.
-- Those reads were relying on Supabase granting `service_role` every table in
-- `public` by default. New Supabase projects no longer do (the baseline's own
-- 0030 note measured "service_role holds no DML on any pw_ table" on a fresh
-- stack), so a database built from these migrations on a new project fails
-- those paths with `permission denied for table pw_workspace_members`. Found
-- on the trust environment (2026-10-04), the first database built from
-- scratch since the squash; staging and production were built incrementally
-- on older projects that still had the default grants.
--
-- The contract workflow (.github/workflows/cloud-contract.yml) and the local
-- contract recipe granted these by hand after migrating, which is why no test
-- saw it. They no longer do: the migrations are now the only source of the
-- grants, so the contract suite exercises the schema as shipped.
--
-- SAFETY
-- Additive only, to one role that already bypasses RLS: a no-op on any
-- database that has the defaults, and safe to apply before or after any code
-- deploy. pw_schema_migrations is skipped — it is read and written only over
-- a direct Postgres connection (0001), never through the Data API.

grant usage on schema public to service_role;

do $$
declare
  t record;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
      and tablename like 'pw\_%'
      and tablename <> 'pw_schema_migrations'
  loop
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t.tablename
    );
  end loop;
end
$$;

grant usage, select on all sequences in schema public to service_role;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'pw\_%'
  loop
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end
$$;

-- Tables a later migration creates get the same grant without having to
-- remember it (0003 and 0004 already name service_role explicitly too).
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
