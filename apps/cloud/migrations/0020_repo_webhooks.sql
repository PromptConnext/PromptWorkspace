-- 0020 — per-repository webhook bindings, replacing the GitHub App's
-- platform-wide signing secret.
--
-- GitHub auth moved from one platform App to a per-workspace fine-grained PAT
-- (ADR 0017 amendment), which removes the shared `GITHUB_WEBHOOK_SECRET`. Each
-- repository the cloud creates now gets its own randomly generated secret,
-- registered on the repo's webhook and stored here as ciphertext
-- (app/secrets.py) — never plaintext, same rule as model-connection keys.
--
-- `repo_full_name` is the PRIMARY KEY, not merely indexed. That is the point:
-- the old routing scanned workspace rows for a client-supplied `repo` string
-- and took the first match, so two workspaces could claim the same repo and
-- one would silently intercept the other's deliveries (issue #3). A repo now
-- maps to exactly one project, and only the cloud writes the binding — at the
-- moment it creates the repo.

create table if not exists pz_repo_webhooks (
    repo_full_name text primary key,
    project_id uuid not null references pz_projects (id),
    workspace_id uuid not null references pz_workspaces (id),
    secret_ref text not null,
    created_at timestamptz not null default now()
);

create index if not exists idx_pz_repo_webhooks_project on pz_repo_webhooks (project_id);

alter table pz_repo_webhooks enable row level security;

-- Deliberately no `authenticated` grant and no permissive policy: the webhook
-- route runs unauthenticated (GitHub is the caller) on the service key, and
-- `secret_ref` must never be reachable from a browser session. Members read
-- nothing here; there is nothing here a member needs.
drop policy if exists pz_repo_webhooks_service_only on pz_repo_webhooks;

revoke all on pz_repo_webhooks from authenticated;

-- The old GitHub App config shape is not migrated. A workspace that had an
-- installation must reconnect with a PAT in workspace settings; leaving the
-- stale `installation_id` in place would read as "connected" while every call
-- path fails. app/integrations/github_auth.py::github_config treats a config
-- without `secret_ref` as not connected, which makes that explicit.
update pz_workspaces
   set integration_config = integration_config - 'github'
 where integration_config ? 'github'
   and not (integration_config -> 'github' ? 'secret_ref');
