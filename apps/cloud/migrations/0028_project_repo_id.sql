-- 0028 — persist the GitHub repository this project actually created (finding
-- 9, docs/cloud-codebase-review-2026-09-06.md). `repo_id` is GitHub's stable
-- numeric repository id, immutable across a rename or transfer — unlike
-- `repo_url`/`full_name`, which a collision can share with an unrelated
-- repository. Written once, at the same step that first writes `repo_url`
-- (apps/cloud/app/api/sync.py::create_repository), before the lifecycle
-- flips to repo_created. Nullable: every project created before this
-- migration has a repo_url with no recorded id.

alter table pz_projects add column if not exists repo_id bigint;
