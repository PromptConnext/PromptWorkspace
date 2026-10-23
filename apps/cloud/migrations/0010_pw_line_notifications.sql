-- 0010_pw_line_notifications — workspace language and LINE group links
-- (plan 0032).
--
-- THE PROBLEM
-- A project's team lives in LINE, not in the inbox. Notifications need an
-- address (a LINE group per project) and a language to be written in.
--
-- SHAPE
-- pw_workspaces.language: 'en' | 'th', default 'en'. Governs LINE messages.
-- pw_project_line_links: the group a project notifies, one per project.
-- pw_line_link_codes: a pending single-use code an admin pastes into the
-- group to link it. A table rather than memory so a restart cannot lose a
-- code. The app expires codes after 15 minutes and burns them on first use.
-- Idempotent: every statement can run twice.
--
-- GRANTS
-- Both new tables are service-only: a group id is where notifications are
-- sent, and a member must not read another project's through PostgREST. RLS
-- is enabled with no policy, and `authenticated`/`anon` lose the default
-- grants 0006 hands every new table. pw_workspaces.language is a plain
-- member-readable column and needs nothing.
--
-- DEPLOY ORDER
-- Apply BEFORE deploying this code: the Supabase adapter's create_workspace
-- inserts every Workspace field, `language` included, so creating a workspace
-- fails (PGRST204, unknown column) until this migration is applied.

alter table pw_workspaces add column if not exists language text not null default 'en';

alter table pw_workspaces drop constraint if exists pw_workspaces_language_check;
alter table pw_workspaces add constraint pw_workspaces_language_check
    check (language in ('en', 'th'));

create table if not exists pw_project_line_links (
    project_id uuid primary key references pw_projects (id) on delete cascade,
    group_id text not null,
    group_name text,
    linked_by uuid not null,
    linked_at timestamptz not null default now()
);

create index if not exists idx_pw_project_line_links_group
    on pw_project_line_links (group_id);

create table if not exists pw_line_link_codes (
    code text primary key,
    project_id uuid not null references pw_projects (id) on delete cascade,
    created_by uuid not null,
    expires_at timestamptz not null
);

create index if not exists idx_pw_line_link_codes_project
    on pw_line_link_codes (project_id);

alter table pw_project_line_links enable row level security;
alter table pw_line_link_codes enable row level security;

revoke all on pw_project_line_links from authenticated;
revoke all on pw_project_line_links from anon;
grant select, insert, update, delete on pw_project_line_links to service_role;

revoke all on pw_line_link_codes from authenticated;
revoke all on pw_line_link_codes from anon;
grant select, insert, update, delete on pw_line_link_codes to service_role;
