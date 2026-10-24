-- 0013_pw_oauth — the cloud as an OAuth 2.1 authorization server for the hosted
-- MCP (design 2026-10-24-hosted-mcp-oauth, "Cloud: the authorization server").
-- Idempotent. All five tables are service-only: every rule lives in the OAuth
-- routes, and code/refresh values are stored only as hashes.
-- DEPLOY ORDER: apply BEFORE deploying this code (the adapter reads and writes these tables).
create table if not exists pw_oauth_clients (
    client_id text primary key,
    kind text not null check (kind in ('preregistered','cimd','dcr')),
    client_name text not null default '',
    redirect_uris jsonb not null default '[]'::jsonb,
    client_uri text,
    logo_uri text,
    token_endpoint_auth_method text not null default 'none',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
);

create table if not exists pw_oauth_requests (
    request_id uuid primary key,
    client_id text not null,
    redirect_uri text not null,
    code_challenge text not null,
    resource text not null,
    scope text not null,
    state text,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    approved_user_id text,
    approved_at timestamptz,
    denied_at timestamptz
);
create index if not exists pw_oauth_requests_expires_idx on pw_oauth_requests (expires_at);

create table if not exists pw_oauth_codes (
    code_hash text primary key,
    request_id uuid not null,
    family_id uuid not null,
    client_id text not null,
    user_id text not null,
    redirect_uri text not null,
    code_challenge text not null,
    resource text not null,
    scope text not null,
    expires_at timestamptz not null,
    used_at timestamptz
);
create index if not exists pw_oauth_codes_expires_idx on pw_oauth_codes (expires_at);

create table if not exists pw_oauth_refresh_tokens (
    token_hash text primary key,
    family_id uuid not null,
    client_id text not null,
    user_id text not null,
    scope text not null,
    resource text not null,
    issued_at timestamptz not null default now(),
    expires_at timestamptz not null,
    rotated_to_hash text,
    rotated_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz,
    user_agent text
);
create index if not exists pw_oauth_refresh_tokens_expires_idx on pw_oauth_refresh_tokens (expires_at);

create table if not exists pw_oauth_families (
    family_id uuid primary key,
    client_id text not null,
    user_id text not null,
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    revoked_reason text
);
create index if not exists pw_oauth_families_user_idx on pw_oauth_families (user_id, created_at desc);

alter table pw_oauth_clients enable row level security;
alter table pw_oauth_requests enable row level security;
alter table pw_oauth_codes enable row level security;
alter table pw_oauth_refresh_tokens enable row level security;
alter table pw_oauth_families enable row level security;
revoke all on pw_oauth_clients, pw_oauth_requests, pw_oauth_codes,
    pw_oauth_refresh_tokens, pw_oauth_families from authenticated;
revoke all on pw_oauth_clients, pw_oauth_requests, pw_oauth_codes,
    pw_oauth_refresh_tokens, pw_oauth_families from anon;
grant select, insert, update, delete on pw_oauth_clients, pw_oauth_requests, pw_oauth_codes,
    pw_oauth_refresh_tokens, pw_oauth_families to service_role;
