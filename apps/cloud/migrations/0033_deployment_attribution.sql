-- 0033 — a build's task set is written once, under a recorded state
-- (docs/plans/0024-delivery-evidence-graph.md M2).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- THE DEFECT
-- 0027_deployment_tasks.sql opens by saying the task set is "frozen at
-- terminal state rather than derived on read, and that is the whole
-- decision", and app/deployments/attribution.py's docstring says the same
-- thing more sharply: "so a force-push, a reassignment or a later edit cannot
-- rewrite what somebody reviewed last Tuesday." Neither was true.
--
-- `freeze_build_tasks` carried no "already computed" check. Three call sites
-- reach it — app/api/github.py twice and the reconciliation sweep in
-- app/deployments/reconcile.py — and GitHub redelivers a webhook freely, so
-- every applicable redelivery re-queried the commit range, re-read the
-- current graph, and overwrote the stored set. A task edited or deleted
-- between the two deliveries silently changed the history of a build a
-- reviewer had already signed off. "Frozen" described an intent, not a
-- behaviour.
--
-- The write was not atomic either: the production adapter deleted the
-- existing set and inserted the new one as two separate PostgREST calls
-- (app/db/supabase_repository.py), so a failure between them erased the
-- record rather than leaving it stale. Of the two outcomes, the one that
-- loses evidence is the worse one.
--
-- THE SHAPE OF THE FIX
-- State on the row, and one function that owns the transition. The function
-- is the only thing that may write pz_deployment_tasks, so the delete, the
-- insert and the stamp cannot come apart, and the "already frozen" test
-- happens under a row lock rather than in the application between two round
-- trips. `attribution_state` is cleared in exactly one place — the admin-only
-- POST /projects/{id}/deployments/{id}/reattribute — so a correction is a
-- deliberate, attributable act rather than a consequence of GitHub's retry
-- policy.
--
-- The function precedent is pz_rag_match_chunks (0023_configurable_embed_dim
-- .sql); the client-side precedent is the `.rpc(...)` call in
-- app/db/supabase_repository.py::vector_search.

-- 'uncomputed' is the honest default for every row that already exists: those
-- builds were attributed under the old unfrozen behaviour, so the platform
-- genuinely does not know whether what is stored is what shipped. The web app
-- renders that as "not yet recorded" rather than as an empty build, which is
-- the point of plan 0024's third defect — an empty result and an uncomputed
-- result are different facts and used to look identical.
alter table pz_deployments
  add column if not exists attribution_state text not null default 'uncomputed';

alter table pz_deployments
  add column if not exists attributed_at timestamptz;

-- Two values, and a constraint rather than a comment, because every reader
-- (the API serialiser, the web rollup, the reattribute endpoint) branches on
-- this string and a third value would reach them as a silent fall-through.
alter table pz_deployments
  drop constraint if exists pz_deployments_attribution_state_check;
alter table pz_deployments
  add constraint pz_deployments_attribution_state_check
  check (attribution_state in ('uncomputed', 'frozen'));

-- Freeze this build's task set, once.
--
-- Returns true when it wrote, false when the row was already frozen or does
-- not exist. A false return is the normal, expected answer to a redelivery —
-- not an error — and the caller reads the stored set back rather than
-- treating its own freshly computed list as authoritative.
--
-- `for update` is what makes the check-then-write safe: two concurrent
-- deliveries of the same terminal event serialise here instead of both
-- observing 'uncomputed' and both writing.
--
-- security invoker (the default) on purpose. The only caller is the server's
-- service-role client, which already holds DML on both tables — every write
-- on this path goes through it today. A definer function would hand the
-- table owner's rights to whoever holds execute, which is a larger grant
-- than this needs.
create or replace function pz_freeze_deployment_tasks(
    p_deployment_id uuid,
    p_task_ids uuid[]
) returns boolean
language plpgsql volatile set search_path = public as $$
declare
  v_state text;
begin
  select attribution_state into v_state
    from pz_deployments
   where id = p_deployment_id
     for update;

  if not found then
    return false;
  end if;

  if v_state = 'frozen' then
    return false;
  end if;

  delete from pz_deployment_tasks where deployment_id = p_deployment_id;

  -- `with ordinality` carries the caller's order into `position`, which is
  -- what 0027 added it for: the Preview tab's list must read the same way
  -- twice. An empty array inserts nothing and still freezes the row — that
  -- is a build that genuinely closed no tasks, and it is now distinguishable
  -- from one nobody ever attributed.
  insert into pz_deployment_tasks (deployment_id, task_id, position)
  select p_deployment_id, t.tid, (t.ord - 1)::integer
    from unnest(p_task_ids) with ordinality as t(tid, ord)
  on conflict (deployment_id, task_id) do nothing;

  update pz_deployments
     set attribution_state = 'frozen',
         attributed_at = now()
   where id = p_deployment_id;

  return true;
end;
$$;

-- Default execute on a function is granted to PUBLIC, which would let any
-- authenticated member freeze or (via the endpoint's absence, merely attempt
-- to) rewrite an attribution. Members read their project's attribution and
-- never author one — the same posture 0027 set on the table itself.
revoke execute on function pz_freeze_deployment_tasks(uuid, uuid[]) from public;
revoke execute on function pz_freeze_deployment_tasks(uuid, uuid[]) from anon;
revoke execute on function pz_freeze_deployment_tasks(uuid, uuid[]) from authenticated;
grant execute on function pz_freeze_deployment_tasks(uuid, uuid[]) to service_role;

-- The function writes both tables on the caller's own rights, so name that
-- role's grant here rather than assuming it (the same reasoning as 0030: on a
-- clean local `supabase start`, service_role holds no DML on any pz_ table,
-- which is why tests/contract/conftest.py has to grant it by hand). Adding a
-- privilege to a role that already bypasses RLS is safe in any order.
grant select, insert, update, delete on pz_deployments to service_role;
grant select, insert, update, delete on pz_deployment_tasks to service_role;
