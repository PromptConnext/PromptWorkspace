-- Fix a real bootstrap deadlock in the membership RLS policy, found by
-- running apps/cloud against a real local Supabase instance for the first
-- time (docs/plans/0004): `pz_members_write`'s WITH CHECK was
-- `pz_is_admin(workspace_id)` with no exception — but the very first
-- membership row for a workspace (the creator adding themselves as admin,
-- in Repository.create_workspace / SupabaseRepository.add_member) can never
-- satisfy that, because no admin exists yet to satisfy it. Workspace
-- creation was unreachable under enforced RLS. This was invisible until now
-- because `for_user()` (which forwards the caller's JWT so RLS applies) was
-- previously dead code, never called from any route — see app/dependencies.py.
--
-- Mirrors pz_ws_write's own bootstrap escape (`created_by = auth.uid() or
-- pz_is_admin(id)`): allow a workspace's own creator to insert exactly one
-- admin membership row for themselves; any other membership write still
-- requires an existing admin.
--
-- The obvious version of this (an inline `exists (select 1 from
-- pz_workspaces ...)` in the policy) does NOT work: pz_workspaces has its
-- own RLS (`pz_ws_read` requires membership), so a plain subquery run as the
-- `authenticated` role hits the *same* bootstrap deadlock one layer down —
-- it can't see the workspace it's supposed to be checking either. Needs a
-- `security definer` helper (same pattern as pz_is_admin/pz_is_member) to
-- read pz_workspaces without going through RLS.
create or replace function pz_created_workspace(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from pz_workspaces where id = ws and created_by = auth.uid());
$$;

drop policy if exists pz_members_write on pz_workspace_members;
create policy pz_members_write on pz_workspace_members for all
  using (pz_is_admin(workspace_id))
  with check (
    pz_is_admin(workspace_id)
    or (user_id = auth.uid() and role = 'admin' and pz_created_workspace(workspace_id))
  );
