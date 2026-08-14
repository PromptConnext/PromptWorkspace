-- 0025 — indexes for the task-status write and the assigned-task read
--
-- WHY
-- ADR 0020 moves authority for the task graph to the cloud and narrows what a
-- developer client writes upward to three things, two of which land here: a
-- task's status, and the commit that evidences it. Two new access paths follow,
-- and neither is served by the indexes 0001 and 0017 created.
--
--   pz_artifacts_task_commit_uniq
--     The git-driven caller re-sends a commit whenever its local cache is
--     dropped or a repo is re-cloned, so `upsert_task_artifact` replaying is
--     the expected case. The repository does a select-then-insert, which is
--     racy on its own; this partial unique index is what actually makes the
--     write idempotent. Partial (`where commit_sha is not null`) because a
--     PR or doc artifact carries no sha and several of them per task is
--     legitimate — only sha-bearing rows are claiming "this exact commit".
--
--   idx_pz_tasks_assigned_user
--     `GET /me/tasks` filters by assigned_user_id across every project the
--     caller belongs to. 0001 indexed (project_id) and (project_id,
--     updated_at); 0017 added assigned_user_id with no index at all, because
--     its only reader at the time was a per-project keyhole pull. Partial,
--     since the overwhelming majority of rows are unassigned.
--
-- SAFETY
-- Both statements are `if not exists` and neither rewrites a table. The unique
-- index can fail on a database that already holds duplicate (task_id,
-- commit_sha) rows — that is the point. If it does, dedupe first:
--
--   delete from pz_artifacts a using pz_artifacts b
--    where a.task_id = b.task_id and a.commit_sha = b.commit_sha
--      and a.commit_sha is not null and a.id > b.id;
--
-- Apply with the runner in migrations/migrate.py (docs/DEPLOYMENT.md §2.2).

create unique index if not exists pz_artifacts_task_commit_uniq
    on pz_artifacts (task_id, commit_sha)
    where commit_sha is not null;

create index if not exists idx_pz_tasks_assigned_user
    on pz_tasks (assigned_user_id)
    where assigned_user_id is not null;
