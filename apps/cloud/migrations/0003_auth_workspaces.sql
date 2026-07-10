-- PromptZone Cloud — Milestone 2: Supabase Auth, workspaces & RLS
--
-- Introduces the workspace access-control tier. Projects move from owner-only
-- to workspace-scoped; access is by membership. Per ADR 0010 §5 the cloud
-- stores only Git *metadata* (Option C) — never a raw credential.
--
-- Rollout (see docs/plans/0001-cloud-deletes-and-auth.md, M2):
--   1. Apply this migration (tables + projects.workspace_id nullable) + backfill.
--   2. Deploy backend with AUTH_MODE=stub, workspace_id optional — verify.
--   3. Enable RLS + flip AUTH_MODE=supabase + JWT-scoped client together.
--   4. Cleanup migration 0006: workspace_id NOT NULL, drop legacy owner_id.

-- Workspaces -----------------------------------------------------------------
create table if not exists pz_workspaces (
    id           uuid primary key default gen_random_uuid(),
    name         text not null,
    created_by   uuid not null,                       -- auth.users.id
    -- Non-secret Git metadata only: {repo_url, provider, default_branch}.
    git_config   jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- Membership -----------------------------------------------------------------
create table if not exists pz_workspace_members (
    workspace_id  uuid not null references pz_workspaces (id) on delete cascade,
    user_id       uuid not null,                      -- auth.users.id
    role          text not null default 'member',     -- 'admin' | 'member'
    invited_by    uuid,
    created_at    timestamptz not null default now(),
    primary key (workspace_id, user_id)
);
create index if not exists idx_pz_members_user on pz_workspace_members (user_id);

-- Invitations ----------------------------------------------------------------
create table if not exists pz_invitations (
    id            uuid primary key default gen_random_uuid(),
    workspace_id  uuid not null references pz_workspaces (id) on delete cascade,
    email         text not null,
    role          text not null default 'member',
    token         text not null unique,
    status        text not null default 'pending',    -- pending|accepted|revoked|expired
    invited_by    uuid not null,
    expires_at    timestamptz not null,
    created_at    timestamptz not null default now()
);
create index if not exists idx_pz_invitations_ws on pz_invitations (workspace_id);

-- Projects gain a workspace --------------------------------------------------
alter table pz_projects add column if not exists workspace_id uuid references pz_workspaces (id) on delete cascade;
create index if not exists idx_pz_projects_workspace on pz_projects (workspace_id);

-- Backfill: give every legacy owner a personal workspace, make them its admin,
-- and move their projects into it. Idempotent-ish (guarded by workspace_id null).
do $$
declare
    legacy_owner text;
    new_ws uuid;
begin
    for legacy_owner in
        select distinct owner_id from pz_projects where workspace_id is null
    loop
        insert into pz_workspaces (name, created_by)
        values (legacy_owner || '''s workspace', legacy_owner::uuid)
        returning id into new_ws;

        insert into pz_workspace_members (workspace_id, user_id, role, invited_by)
        values (new_ws, legacy_owner::uuid, 'admin', legacy_owner::uuid)
        on conflict do nothing;

        update pz_projects set workspace_id = new_ws
        where owner_id = legacy_owner and workspace_id is null;
    end loop;
end $$;

-- Row Level Security ---------------------------------------------------------
-- The backend forwards the caller's JWT so Postgres enforces membership as
-- defense in depth beneath the app-layer checks. Enable at the M2 cutover.
alter table pz_workspaces        enable row level security;
alter table pz_workspace_members enable row level security;
alter table pz_projects          enable row level security;
alter table pz_requirements      enable row level security;
alter table pz_spec_documents    enable row level security;
alter table pz_tasks             enable row level security;
alter table pz_artifacts         enable row level security;
alter table pz_agent_runs        enable row level security;

create or replace function pz_is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pz_workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

create or replace function pz_is_admin(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from pz_workspace_members m
    where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

-- Workspace: readable by members, writable by admins.
drop policy if exists pz_ws_read on pz_workspaces;
create policy pz_ws_read  on pz_workspaces for select using (pz_is_member(id));
drop policy if exists pz_ws_write on pz_workspaces;
create policy pz_ws_write on pz_workspaces for all
  using (pz_is_admin(id)) with check (created_by = auth.uid() or pz_is_admin(id));

-- Membership rows: visible to members of the same workspace; admins manage.
drop policy if exists pz_members_read on pz_workspace_members;
create policy pz_members_read  on pz_workspace_members for select using (pz_is_member(workspace_id));
drop policy if exists pz_members_write on pz_workspace_members;
create policy pz_members_write on pz_workspace_members for all
  using (pz_is_admin(workspace_id)) with check (pz_is_admin(workspace_id));

-- Projects: scoped through their workspace.
drop policy if exists pz_projects_rw on pz_projects;
create policy pz_projects_rw on pz_projects for all
  using (pz_is_member(workspace_id)) with check (pz_is_member(workspace_id));

-- Graph tables: scoped through the project's workspace.
do $$
declare t text;
begin
  foreach t in array array[
    'pz_requirements','pz_spec_documents','pz_tasks','pz_artifacts','pz_agent_runs'
  ] loop
    execute format('drop policy if exists %I_rw on %I', t, t);
    execute format($f$
      create policy %I_rw on %I for all
        using (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)))
        with check (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)))
    $f$, t, t);
  end loop;
end $$;
