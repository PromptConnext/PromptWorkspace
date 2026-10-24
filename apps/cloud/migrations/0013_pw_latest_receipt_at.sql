-- 0013_pw_latest_receipt_at — newest receipt time per project in one call
-- (plan 0033 closing, task 22). Idempotent.
--
-- THE PROBLEM
-- The workspace overview needs the latest receipt time for up to 200
-- projects. Reading every receipt row and keeping the first per project
-- drains the whole chain table through PostgREST's row cap.
--
-- SHAPE
-- pw_latest_receipt_at(p_project_ids uuid[]) returns one row per project that
-- has a receipt: (project_id, created_at = max). Projects without receipts
-- are absent.
--
-- GRANTS
-- Service-only, like the tables it reads: the API calls it with the service
-- key. Execute is revoked from public, anon and authenticated.
--
-- DEPLOY ORDER
-- Apply any time. The adapter falls back to the paged read when the
-- function does not exist yet (SQLSTATE 42883 / PGRST202).

create or replace function pw_latest_receipt_at(p_project_ids uuid[])
returns table (project_id uuid, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select project_id, max(created_at)
  from pw_receipts
  where project_id = any(p_project_ids)
  group by project_id
$$;

revoke all on function pw_latest_receipt_at(uuid[]) from public, anon, authenticated;
grant execute on function pw_latest_receipt_at(uuid[]) to service_role;
