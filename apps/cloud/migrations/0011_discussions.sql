-- PromptZone Cloud — Milestone 12: Discussion entity (plan 0005, ADR 0011)
--
-- Comments threaded on any graph node. Unlike pz_tasks (row-level split
-- ownership: status is pz-only, assignee is pmo-only), a discussion row is
-- created wholesale by one source or the other — pz (web/desktop) and pmo
-- (Jira comment mirror, M12) never fight over the same row's fields, they
-- each create their own rows. field_versions/FIELD_AUTHORITY still apply
-- ("shared") for the same-row-edited-twice case (e.g. re-syncing your own
-- comment), consistent with every other graph table.
--
-- Built fresh here (not editing 0001/0002/0003/0004) with deleted_at and
-- field_versions already included, rather than the historical
-- init-then-backfill sequence those migrations show — this table didn't
-- exist when that sequence of gaps was being closed.

create table if not exists pz_discussions (
    id                uuid primary key default gen_random_uuid(),
    project_id        uuid not null references pz_projects (id) on delete cascade,
    parent_node_type  text not null,   -- 'requirements' | 'spec_documents' | 'tasks' | 'artifacts'
    parent_node_id    uuid not null,
    author            uuid not null,
    body              text not null,
    source            text not null default 'pz' check (source in ('pz', 'pmo')),
    field_versions    jsonb not null default '{}'::jsonb,
    deleted_at        timestamptz,
    updated_at        timestamptz not null default now()
);

create index if not exists idx_pz_discussions_project on pz_discussions (project_id);
create index if not exists idx_pz_discussions_parent on pz_discussions (parent_node_type, parent_node_id);
create index if not exists idx_pz_discussions_live on pz_discussions (project_id) where deleted_at is null;

alter table pz_discussions enable row level security;

-- Same shape as the do-block in 0003_auth_workspaces.sql that scopes every
-- other graph table through the project's workspace — written directly here
-- rather than re-running that migration's loop against an old file.
drop policy if exists pz_discussions_rw on pz_discussions;
create policy pz_discussions_rw on pz_discussions for all
  using (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)))
  with check (pz_is_member((select workspace_id from pz_projects p where p.id = project_id)));

grant select, insert, update, delete on pz_discussions to authenticated;

-- RAG opt-in for pmo-mirrored (Jira) comments (ADR 0011: third-party content
-- defaults OUT; pz-native discussions are always in). A typed column on the
-- workspace, not another integration_config key.
alter table pz_workspaces add column if not exists rag_index_pmo_discussions boolean not null default false;
