-- PromptZone Cloud — Milestone 3: per-field conflict ownership
--
-- Row-level LWW silently drops concurrent edits and cannot coexist with an
-- external tracker (Jira owns assignee, PromptZone owns status). We move to
-- field-level merge with declared ownership; this needs per-field version
-- clocks, stored as a jsonb map {field: {updated_at, source}}.
--
-- Additive & backward-compatible: existing rows get an empty field_versions
-- and behave as LWW until their first field-scoped write.

alter table pz_tasks          add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_requirements   add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_spec_documents add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_artifacts      add column if not exists field_versions jsonb not null default '{}'::jsonb;
alter table pz_agent_runs     add column if not exists field_versions jsonb not null default '{}'::jsonb;

-- New PMO fields on tasks, populated by the external-tracker mirror (M5).
alter table pz_tasks add column if not exists assignee text;
alter table pz_tasks add column if not exists sprint   text;
