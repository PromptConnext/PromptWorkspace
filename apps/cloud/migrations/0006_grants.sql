-- Grant base table privileges to `authenticated` (RLS then narrows per-row).
--
-- Found by running apps/cloud against a real local Supabase instance for the
-- first time (docs/plans/0004): every prior migration created RLS policies
-- but never granted the underlying table privileges. Supabase's local/hosted
-- bootstrap only grants TRUNCATE/REFERENCES/TRIGGER schema-wide by design —
-- SELECT/INSERT/UPDATE/DELETE are left to each project's own migrations, and
-- RLS policies are silently unreachable without them (Postgres checks the
-- base GRANT before RLS ever runs). Every prior request to a real Supabase
-- project would have failed with `permission denied for table ...` — this
-- was not previously exercised end-to-end.
grant select, insert, update, delete on
  pz_projects,
  pz_requirements,
  pz_spec_documents,
  pz_tasks,
  pz_artifacts,
  pz_agent_runs,
  pz_workspaces,
  pz_workspace_members,
  pz_invitations,
  pz_task_links
to authenticated;

-- Future tables this app creates should get the same treatment automatically.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
