-- 0035 — how a project came by its repository (docs/plans/0027-brownfield-repo-import.md).
--
-- Apply with scripts/migrate.py; never edit this file once applied — the
-- pz_schema_migrations ledger (0024) checksums it and reports drift.
--
-- `repo_origin` is 'imported' when POST /projects adopted a repository the
-- user picked, 'created' when create_repository created one. It replaces the
-- repository's GitHub description as the signal create_repository's
-- crash-window retry reads to decide between the full seed (a repository the
-- platform created, safe to write at its conventional paths) and the
-- relocated, non-overwriting one: a description is editable by anyone with
-- admin on the repository, so it could be set to the platform's own string
-- to earn an imported repository the overwriting seed.
--
-- Deliberately NOT backfilled. A project with a repo_url and no origin is
-- either an import or a from-scratch project caught in the crash window
-- between recording repo_url and flipping to repo_created, and nothing in
-- this table tells the two apart. The application treats NULL as imported
-- (app/models/schemas.py::Project.is_imported): the relocated seed and the
-- baseline gate are the readings that cannot overwrite a team's files. A
-- backfill guessing 'imported' from `repo_url is not null` would bake the
-- same guess into data and lose the NULL that marks it as one.

alter table pz_projects add column if not exists repo_origin text;

alter table pz_projects
  drop constraint if exists pz_projects_repo_origin_check;
alter table pz_projects
  add constraint pz_projects_repo_origin_check
  check (repo_origin is null or repo_origin in ('imported', 'created'));
