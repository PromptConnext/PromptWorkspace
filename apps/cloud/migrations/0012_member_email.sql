-- PromptZone Cloud — Milestone 13: denormalize member email
--
-- pz_workspace_members only stored user_id (auth.users.id), forcing the web
-- UI to render a raw UUID for "who is this member" — auth.users itself is
-- only readable by service_role, so a join isn't an option for the
-- anon/authenticated roles this app queries as. Denormalize the email onto
-- the membership row instead, populated at insert time (create_workspace /
-- accept_invitation already know it — from the session or the invitation).
-- Existing rows backfill to null; the UI falls back to the id for those.

alter table pz_workspace_members add column if not exists email text;
