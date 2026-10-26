-- 0015_pw_applied_migrations — applied migration filenames, readable by the API
-- (plan 0034, task 1). Idempotent.
--
-- THE PROBLEM
-- The service cannot tell whether its database is behind its code. The ledger
-- table pw_schema_migrations records every applied file, but it is deliberately
-- unreadable over REST (no grants to the API roles) and stays that way.
--
-- SHAPE
-- pw_applied_migrations() returns setof text: the filename of every ledger row,
-- ordered. Filenames only: no checksums, no timestamps, no applied_by.
--
-- GRANTS
-- Service-only, like the tables it reads: the API calls it with the service
-- key. Execute is revoked from public, anon and authenticated.
--
-- DEPLOY ORDER
-- Apply either side of the code. The code tolerates the function's absence
-- (the gate reports state `unknown`), so deploying the gate is never blocked
-- by this migration.

create or replace function pw_applied_migrations()
returns setof text
language sql stable security definer set search_path = public as $$
  select filename from pw_schema_migrations order by filename
$$;

revoke all on function pw_applied_migrations() from public, anon, authenticated;
grant execute on function pw_applied_migrations() to service_role;
