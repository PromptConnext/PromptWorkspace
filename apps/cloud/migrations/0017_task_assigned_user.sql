-- PromptConnext Cloud — task assignment to workspace members (ADR 0016)
--
-- A pz-owned assignee distinct from the pmo `assignee` (a tracker display
-- name). Holds a workspace member's user_id; the app sets it via
-- PATCH /projects/{id}/tasks/{tid}/assignment, merged source="pz".
-- Additive & backward-compatible: existing rows default to NULL (unassigned).

alter table pz_tasks add column if not exists assigned_user_id text;
