-- 0026 — Deployment templates: a project's selected deploy pipeline, and the
-- deployments its own CI reports back (ADR 0021).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- Two additive columns on pz_projects, mirroring 0022's policy_scope:
--
--   deployment_config  the Tech Lead's frozen INPUT   {template_id}
--   deployment_state   the server-written CURRENT VIEW {state, url, ...}
--
-- Separate on purpose: different lifetimes (config freezes at repo_created,
-- state mutates forever), different writers (a member PATCH versus the
-- signed webhook route), and different authorization. One column would put
-- those two writers in a race for no benefit.
--
-- deployment_state duplicates the newest pz_deployments row. That is the same
-- trade repo_url already makes: GET /projects backs the workspace project
-- list and the engine roster projection, and neither can afford a join or an
-- N+1 to answer "is this project live, and where".

alter table pz_projects add column if not exists deployment_config jsonb;
alter table pz_projects add column if not exists deployment_state jsonb;

-- One row per deploy. NOT secret-bearing: URLs, states, commit shas and run
-- links only. The provider credential lives encrypted (Fernet, app/secrets.py)
-- in pz_workspaces.integration_config, exactly like the GitHub PAT, and never
-- reaches this table.
create table if not exists pz_deployments (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null references pz_workspaces (id),
    project_id uuid not null references pz_projects (id),
    provider text not null,
    template_id text not null,
    -- Idempotency key, and the reason for the unique constraint below: one
    -- deploy emits several deliveries (in_progress -> success), so without a
    -- stable key each would insert a duplicate instead of updating.
    external_key text not null,
    state text not null,
    url text,
    commit_sha text,
    ref text,
    run_url text,
    error_code text,
    error_message text,
    -- Measured by a server-side HEAD after a successful deploy: allow | deny
    -- | unknown. A browser cannot read a cross-origin response header, so
    -- this is the only place the answer can come from.
    frame_policy text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project_id, external_key)
);

create index if not exists idx_pz_deployments_project_created
    on pz_deployments (project_id, created_at desc);

alter table pz_deployments enable row level security;

drop policy if exists pz_deployments_read on pz_deployments;
create policy pz_deployments_read on pz_deployments
  for select using (pz_is_member(workspace_id));

-- SELECT only, deliberately — a third posture, between 0019 (members read and
-- write) and 0020 (no grant at all). Every row here is written by the
-- unauthenticated, HMAC-verified webhook route, which runs on the service key
-- (app/dependencies.py::get_repository returns the unscoped repository when a
-- request carries no Authorization header, and GitHub sends none). No member
-- ever authors a deployment, so no member needs insert/update/delete. But
-- members do legitimately read their own project's deploy history, which is
-- why this is not the 0020 no-grant posture.
grant select on pz_deployments to authenticated;
