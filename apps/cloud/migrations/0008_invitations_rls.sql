-- pz_invitations never had row-level security enabled at all (migration
-- 0003 enabled RLS on every other new table but missed this one — grep
-- confirms no `enable row level security` / policy for it anywhere).
-- Found while verifying apps/cloud against a real local Supabase instance
-- (docs/plans/0004): before 0006_grants.sql, `authenticated` had no base
-- table privileges either, so this was accidentally locked down (but
-- non-functional). After 0006 granted SELECT/INSERT/UPDATE/DELETE broadly,
-- it became a real hole — any authenticated user could read or modify any
-- workspace's invitations (see other workspaces' pending invite tokens,
-- change roles, mark invites accepted, etc). Closing it now, in the same
-- session that opened the gap, rather than shipping 0006 alone.
alter table pz_invitations enable row level security;

-- Manageable (create/revoke/read) by workspace admins.
drop policy if exists pz_invitations_admin on pz_invitations;
create policy pz_invitations_admin on pz_invitations for all
  using (pz_is_admin(workspace_id))
  with check (pz_is_admin(workspace_id));

-- The invited person themselves (matched by email — the invite is
-- addressed to an email, not a user id, since the invitee may not have an
-- account when invited) needs SELECT (accept_invitation reads it by token
-- before the caller is a member) and UPDATE (marking their own invite
-- accepted/expired) — but not INSERT/DELETE, only an admin creates/revokes.
-- Postgres RLS policies take exactly one command in FOR, not a list —
-- hence two policies rather than `for select, update`.
drop policy if exists pz_invitations_invitee_read on pz_invitations;
create policy pz_invitations_invitee_read on pz_invitations for select
  using (email = auth.email());

-- RLS restricts *rows*, not *columns* — `email = auth.email()` alone would
-- let an invitee UPDATE any column of a row they can already reach,
-- including `workspace_id` and `role`. Since app code only ever updates
-- `status` (verified: grep of app/db/supabase_repository.py shows no other
-- column touched by UPDATE), lock this down two ways: a column-level GRANT
-- so only `status` is writable at all regardless of which policy matches,
-- and a row policy that only allows a *pending* invite to move to
-- *accepted*/*expired* — not an admin rewriting it to point at a different
-- workspace/role and then "accepting" their own tampered row. Without both,
-- an authenticated user who has ever received even one invitation (to any
-- workspace, expired or revoked) could rewrite that row's workspace_id and
-- role to an arbitrary target and self-escalate to admin there — a real
-- privilege-escalation gap, caught by review before this ever ran anywhere
-- but a local throwaway test database.
revoke update on pz_invitations from authenticated;
grant update (status) on pz_invitations to authenticated;

drop policy if exists pz_invitations_invitee_update on pz_invitations;
create policy pz_invitations_invitee_update on pz_invitations for update
  using (email = auth.email() and status = 'pending')
  with check (email = auth.email() and status in ('accepted', 'expired'));

-- Second half of the same bug class as 0007: accept_invitation() calls
-- add_member() for the *accepting* user, who is neither already an admin
-- nor the workspace's creator — 0007's bootstrap escape doesn't cover them.
-- Allow a self-membership-insert when a matching accepted invitation exists
-- (accept_invitation marks the invitation accepted before adding the member).
create or replace function pz_has_accepted_invite(ws uuid, r text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pz_invitations i
    where i.workspace_id = ws
      and i.role = r
      and i.email = auth.email()
      and i.status = 'accepted'
  );
$$;

-- USING needs the same bootstrap/invite-acceptance escape as WITH CHECK, not
-- just WITH CHECK alone: `add_member()` uses `.upsert(on_conflict=...)`, and
-- Postgres's RLS for `INSERT ... ON CONFLICT DO UPDATE` evaluates the
-- UPDATE-side USING clause too — to guarantee RLS would hold *if* the
-- update branch were taken — even when the row is brand new and no actual
-- conflict occurs. Verified directly: the exact same insert that succeeds
-- as a plain INSERT was rejected once routed through ON CONFLICT DO UPDATE,
-- purely because USING (unlike WITH CHECK at the time) had no bootstrap
-- escape. This is documented Postgres behavior, not a bug in Postgres.
create or replace function pz_can_self_add_member(ws uuid, uid uuid, r text) returns boolean
language sql stable security definer set search_path = public as $$
  select uid = auth.uid()
    and (
      (r = 'admin' and pz_created_workspace(ws))
      or pz_has_accepted_invite(ws, r)
    );
$$;

drop policy if exists pz_members_write on pz_workspace_members;
create policy pz_members_write on pz_workspace_members for all
  using (pz_is_admin(workspace_id) or pz_can_self_add_member(workspace_id, user_id, role))
  with check (pz_is_admin(workspace_id) or pz_can_self_add_member(workspace_id, user_id, role));
