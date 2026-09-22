-- 0032 — a tracker reference is unique per *account*, not per provider
-- (docs/plans/0019-tracker-account-identity.md M1; finding 16 of
-- docs/cloud-codebase-review-2026-09-06.md).
--
-- THE DEFECT
-- `pz_task_links` was keyed `(provider, external_key)` (0005_tracker_links.sql
-- line 18), and `app/api/integrations.py::tracker_webhook` routed an inbound
-- delivery on exactly that pair. A Jira issue key is unique within a *site*,
-- not within Jira: project keys are short and operators reuse them, so two
-- workspaces that each connect their own Atlassian tenant and each run a
-- project keyed `PZ` both address the row `('jira', 'PZ-1')`. Whichever
-- mirrored first owned it; a delivery from either site then updated that one
-- task, and the comment path collided the same way on
-- `jira-comment-<jira's own comment id>`. The only thing standing between the
-- two was `JIRA_WEBHOOK_SECRET` — one process-wide value every configured site
-- holds, which proves "some configured Jira sent this" and never "which one".
--
-- THE SHAPE OF THE FIX IS NOT NEW
-- This is the same bug GitHub webhooks had (issue #3) and the same fix:
-- 0020_repo_webhooks.sql gave each repository its own row with its own
-- generated signing secret, and `app/api/github.py::github_webhook` routes on
-- an identity taken from the payload *before* it verifies, so an unrecognized
-- identity is dropped before its payload is trusted. `pz_workspace_integrations`
-- is that table for trackers: one row per (workspace, provider), carrying the
-- account it is bound to and that account's own secret.
--
-- WHY `account_key` IS THE SITE BASE URL
-- Jira Cloud webhooks carry no stable installation id this codebase can route
-- on — `JiraAdapter.handle_webhook` sees only `issue.key`, `fields` and
-- `comment` — but every payload's `issue.self` is an absolute URL on the
-- sending tenant's own host, and `JiraIntegrationConfig.base_url` (already
-- required and already host-allowlisted at configuration time) is unique per
-- tenant. Normalized to scheme + host, lowercased, trailing slash stripped
-- (`app/integrations/account.py::normalize_account_key`), that is an identity
-- both sides can produce. `unique (provider, account_key)` below is what turns
-- "unlikely to collide" into "cannot": two workspaces can only coexist here if
-- their sites genuinely differ, which is the one thing an operator cannot get
-- wrong the way they can get a three-letter project prefix wrong.

create table if not exists pz_workspace_integrations (
    workspace_id        uuid not null references pz_workspaces (id) on delete cascade,
    provider            text not null,                -- 'jira' | 'clickup'
    -- The normalized provider account this workspace is bound to (for Jira,
    -- the site base URL). NOT NULL and non-empty by constraint: `''` is the
    -- backfill value on pz_task_links.account_key below, and it must never be
    -- a value an inbound delivery can resolve to.
    account_key         text not null check (account_key <> ''),
    -- Ciphertext (app/secrets.py), exactly as pz_repo_webhooks.secret_ref.
    -- Generated per account at configuration time; never a shared value, and
    -- never plaintext in Postgres.
    webhook_secret_ref  text not null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    primary key (workspace_id, provider),
    constraint pz_workspace_integrations_account_unique unique (provider, account_key)
);

-- Link rows record which account they belong to. Additive with a default,
-- matching 0004_field_ownership.sql's style, so this migration applies to a
-- populated table without a rewrite of application state.
--
-- DELIBERATELY NOT BACKFILLED. A pre-existing link keeps `account_key = ''`,
-- which no configured account can ever equal (the check constraint above), so
-- an inbound delivery stops resolving it rather than resolving it to whichever
-- site asked first. That is the fail-closed direction: the cost is that a link
-- mirrored before this migration must be re-mirrored to start receiving
-- updates again, and the alternative — deriving each row's site from its
-- workspace's stored base_url — would have to guess for any workspace that has
-- since changed or removed its Jira config, and would make the primary key
-- below fail to build on exactly the colliding data this plan exists to
-- separate.
alter table pz_task_links add column if not exists account_key text not null default '';

-- The key the whole plan turns on. Every existing row carries account_key =
-- '', so the new three-column key is uniquely satisfiable by exactly the data
-- the two-column key already permitted; nothing can conflict at this point.
alter table pz_task_links drop constraint if exists pz_task_links_pkey;
alter table pz_task_links add constraint pz_task_links_pkey
  primary key (provider, account_key, external_key);

create index if not exists idx_pz_workspace_integrations_workspace
  on pz_workspace_integrations (workspace_id);

-- --------------------------------------------------------------------------
-- Grants and RLS
-- --------------------------------------------------------------------------
-- 0006_grants.sql's `alter default privileges ... to authenticated` is still
-- in force, so the table above was born with select/insert/update/delete for
-- `authenticated` (and Supabase's own bootstrap does the same for `anon`).
-- Take it all back first, then hand back only what a member legitimately
-- needs. Without this revoke, `webhook_secret_ref` would be readable by any
-- signed-in member's own JWT straight at the PostgREST data API — the exact
-- exposure 0021_repo_webhooks_anon_revoke.sql closed for the GitHub table.
revoke all on pz_workspace_integrations from authenticated;
revoke all on pz_workspace_integrations from anon;

-- Column-level SELECT, not table-level. Unlike pz_repo_webhooks ("there is
-- nothing here a member needs"), the non-secret columns here are a workspace's
-- own settings and are useful to a settings UI, so a member may read them —
-- but `webhook_secret_ref` is absent from this list and therefore unreachable
-- from a browser session, whatever the row policy says. `anon` gets nothing.
-- Writes are the server's alone: no insert/update/delete to any client role,
-- and app/db/supabase_repository.py puts this table in _SERVICE_ONLY_TABLES so
-- the server reaches it on the service-role client.
grant select (workspace_id, provider, account_key, created_at, updated_at)
  on pz_workspace_integrations to authenticated;

grant select, insert, update, delete on pz_workspace_integrations to service_role;

-- pz_task_links was never named in 0030_graph_tables_grant_service_role.sql,
-- and the inbound webhook route reads it as `service_role` (the route is
-- unauthenticated, so app/dependencies.py::get_repository hands it the
-- unscoped service repository). Additive, and a no-op where the grant already
-- exists — same reasoning as 0030's, applied to the one table this plan makes
-- the webhook path depend on.
grant select, insert, update, delete on pz_task_links to service_role;

-- ...and pz_task_links becomes service-only, exactly as the seven graph tables
-- did in 0031. This is not tidying: `account_key` is, as of this migration, a
-- tenant boundary the inbound webhook routes on, while the table's policy from
-- 0005_tracker_links.sql:30-32 tests workspace membership and nothing else and
-- 0006_grants.sql handed `authenticated` insert/update/delete outright. A
-- member could therefore POST a row into their own project naming a *victim's*
-- account_key. `_resolve_link`'s workspace check means the planted row is
-- dropped rather than acted on, so it is not a cross-tenant write — but the
-- planted row still occupies the victim's (provider, account_key, external_key)
-- triple and suppresses their legitimate mirror. Only the server writes here;
-- app/db/supabase_repository.py's _SERVICE_ONLY_TABLES is the paired change.
revoke all on pz_task_links from authenticated;
revoke all on pz_task_links from anon;

alter table pz_workspace_integrations enable row level security;

-- Mirrors pz_task_links' own policy in 0005_tracker_links.sql:27-32, narrowed
-- to SELECT: membership decides which rows a member sees, and the column grant
-- above decides which columns. There is no client-writable path, by design —
-- a member who could INSERT here could claim another tenant's account_key and
-- re-open the collision this migration closes.
drop policy if exists pz_workspace_integrations_read on pz_workspace_integrations;
create policy pz_workspace_integrations_read on pz_workspace_integrations for select
  using (pz_is_member(workspace_id));
