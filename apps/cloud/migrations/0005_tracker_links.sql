-- PromptZone Cloud — Milestone 5: Jira / ClickUp two-way mirror
--
-- A thin sync boundary: mirror only status/assignment/linkage. The AI-native
-- execution graph stays in PromptZone. Direction per field is decided by M3's
-- ownership split (pz out, pmo in).

-- Non-secret per-provider tracker settings live on the workspace.
alter table pz_workspaces add column if not exists integration_config jsonb not null default '{}'::jsonb;

-- Task <-> external issue mapping.
create table if not exists pz_task_links (
    task_id       uuid not null references pz_tasks (id) on delete cascade,
    project_id    uuid not null references pz_projects (id) on delete cascade,
    provider      text not null,                 -- 'jira' | 'clickup'
    external_key  text not null,                 -- e.g. Jira issue key "PZ-42"
    external_url  text not null default '',
    updated_at    timestamptz not null default now(),
    primary key (provider, external_key)
);
create index if not exists idx_pz_task_links_task on pz_task_links (task_id, provider);
create index if not exists idx_pz_task_links_project on pz_task_links (project_id);

-- NOTE: tracker CREDENTIALS (Jira API token, webhook secret) are NOT stored
-- here. They come from the server environment / secret manager, keeping the
-- ADR 0010 §5 "no raw secrets in the cloud DB" posture. This table and
-- integration_config hold only non-secret linkage + settings.

alter table pz_task_links enable row level security;
drop policy if exists pz_task_links_rw on pz_task_links;
create policy pz_task_links_rw on pz_task_links for all
  using (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)))
  with check (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)));
