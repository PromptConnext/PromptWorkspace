-- 0027 — Which tasks are in which build (ADR 0023 decision 4).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- Frozen at terminal state rather than derived on read, and that is the whole
-- decision. The task set for a build is computed from the commits between it
-- and the previous successful build; a force-push, a task reassignment or a
-- later edit would silently rewrite the history of what a stakeholder
-- reviewed last Tuesday if this were a view.
--
-- `position` preserves the order the resolver produced (task order within the
-- graph), so the Preview tab's "what's in this build" list reads the same way
-- twice.

create table if not exists pz_deployment_tasks (
    deployment_id uuid not null references pz_deployments (id) on delete cascade,
    task_id uuid not null,
    position integer not null default 0,
    created_at timestamptz not null default now(),
    primary key (deployment_id, task_id)
);

create index if not exists idx_pz_deployment_tasks_deployment
    on pz_deployment_tasks (deployment_id, position);

-- No FK to pz_tasks: a task deleted after a build shipped must not take the
-- record of what shipped with it. The read path resolves titles from the
-- graph and simply omits a task it can no longer find.

alter table pz_deployment_tasks enable row level security;

drop policy if exists pz_deployment_tasks_read on pz_deployment_tasks;
-- Membership is checked through the parent deployment: every row here belongs
-- to exactly one deployment, and pz_deployments already carries workspace_id.
create policy pz_deployment_tasks_read on pz_deployment_tasks
  for select using (
    exists (
      select 1 from pz_deployments d
      where d.id = pz_deployment_tasks.deployment_id and pz_is_member(d.workspace_id)
    )
  );

-- SELECT only, matching 0026's posture: every row is written by the
-- HMAC-verified webhook path running on the service key. No member authors an
-- attribution, but members legitimately read their own project's.
grant select on pz_deployment_tasks to authenticated;
