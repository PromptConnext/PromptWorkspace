-- 0014_pw_oauth_family_last_used — when a grant (token family) was last used,
-- for the Connected agents list (design 2026-10-24-hosted-mcp-oauth). Set on
-- each refresh and, from /mcp, at most once per five minutes. Idempotent.
-- DEPLOY ORDER: apply BEFORE deploying this code (the adapter writes the column).
alter table pw_oauth_families add column if not exists last_used_at timestamptz;
