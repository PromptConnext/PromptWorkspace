-- PromptConnext Cloud — project lifecycle status + repo linkage (cloud
-- Planner UI, sub-project A). Tracks the planning -> pending_tech_review ->
-- tech_review -> repo_created handoff between business user, Tech Lead, and
-- desktop app (docs/superpowers/specs/2026-07-25-cloud-planner-ui-design.md).
-- Additive & backward-compatible: existing rows default to 'planning'.

alter table pz_projects add column if not exists lifecycle_status text not null default 'planning';
alter table pz_projects add column if not exists repo_url text;
alter table pz_projects add column if not exists repo_default_branch text;
