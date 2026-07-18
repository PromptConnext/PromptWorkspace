# Workspace experience — Sub-project 1: Cloud foundation

Status: Approved 2026-07-18 · Part 1 of 4 (workspace experience)

## Goal

Add the backend contracts the rest of the workspace experience depends on: a real
membership-scoped project listing, invitation list/revoke, a hardened invite
token, and email delivery of invitations through Supabase's configured SMTP.
All in `apps/cloud` (FastAPI + pytest). No web/desktop changes here.

## Shared model (applies across all four sub-projects)

The **active workspace** is the session's working scope. Web persists it in
`localStorage`; desktop persists it in the engine's `app_state`. On entering an
authenticated app with no valid active workspace: 0 memberships → empty/create
state; exactly 1 → auto-enter; >1 → picker. A remembered choice auto-resumes.
Everything downstream (projects, agents, repos, permissions, settings) scopes to
the active workspace.

## Endpoints

### `GET /workspaces/{workspace_id}/projects`
Membership-scoped project list, replacing the web's current fetch-all-`/projects`
+ client filter. Requires `require_workspace` (403 `not_a_member`). Returns
`list[Project]` for that workspace only. Repository gains
`list_projects(workspace_id)` (both `InMemoryRepository` and
`SupabaseRepository`). In supabase mode RLS already scopes by membership; the
app-layer guard is the primary gate.

### `GET /workspaces/{workspace_id}/invitations`
Admin-only (`require_admin`, 403 `admin_required`). Returns pending invitations
for the workspace: `list[Invitation]` filtered to `status == "pending"` and not
expired. Repository gains `list_invitations(workspace_id, status="pending")`.

### `DELETE /workspaces/{workspace_id}/invitations/{invitation_id}`
Admin-only. Sets `status = "revoked"` (the enum value already exists,
`schemas.py:82`, currently never set). 404 if the invitation doesn't exist or
isn't in this workspace. 409 if it is not `pending` (can't revoke an
accepted/expired one). Repository gains `revoke_invitation(workspace_id, id)`.

## Token hardening

`create_invitation` currently sets `token = new_id()` (`uuid4`,
`schemas.py:238`). Change the token to `secrets.token_urlsafe(32)` — the token
grants workspace membership on accept, so it must be an unguessable secret, not a
UUID. The `id` stays a UUID; only the `token` field changes. Accept-by-token
(`POST /invitations/{token}/accept`) is unchanged in shape.

## Email delivery (Supabase Admin)

On `POST /workspaces/{id}/invitations`, after persisting the invite row, send the
invitation email via the Supabase Admin API using the service-role key the cloud
already holds (`SUPABASE_KEY`):

- Primary: `auth.admin.inviteUserByEmail(email, { redirect_to: f"{WEB_APP_URL}/invite/{token}" })`.
  Supabase creates the auth user (if new) and emails a link through its
  configured SMTP; the link lands on the web accept page carrying our token.
- **Existing-user limitation (explicit):** if the email already has a Supabase
  account, `inviteUserByEmail` returns an `email_exists`/422 error and sends
  nothing. Catch that specific case, do **not** fail the request (the invite row
  is valid), and return the invite normally. The response always includes the
  accept URL (`{WEB_APP_URL}/invite/{token}`) so the admin can copy/share it
  regardless of whether email went out. A dedicated transactional-email path for
  existing users is out of scope (tracked follow-up).
- New config: `WEB_APP_URL` in `Settings` (default `http://localhost:3000`;
  production points at the deployed web origin). Used only to build the accept
  link.
- Email sending must be **best-effort**: a Supabase email failure (other than the
  existing-user case) is logged, not surfaced as a 5xx — the invitation still
  exists and is usable via its link. Response carries a boolean `email_sent` so
  the UI can tell the admin whether to share the link manually.

### Response shape change
`Invitation` response gains a computed `accept_url` and the create response adds
`email_sent: bool`. Prefer a distinct `InvitationCreateResponse`
(`{invitation: Invitation, accept_url: str, email_sent: bool}`) over mutating the
stored `Invitation` model, so the list endpoint's shape stays clean.

## Data model

No new tables — `pz_invitations` already has all fields (migration 0003) and RLS
(migration 0008). Only the `token` generation and two new read/write paths on
existing columns change. If the Supabase client isn't already a dependency for
admin calls, wire it through the existing secret/settings plumbing; do not add a
second HTTP client.

## Error handling

- List/revoke: 403 for non-admins, 404 for cross-workspace or missing ids, 409
  for revoking a non-pending invite.
- Email: existing-user 422 swallowed (invite still returned); other email errors
  logged, `email_sent=false`, 201 still returned.
- Scoped projects: 403 `not_a_member`.

## Testing (pytest, stub mode)

- `GET /workspaces/{id}/projects`: member sees only that workspace's projects;
  non-member 403; empty workspace returns `[]`.
- `GET /workspaces/{id}/invitations`: admin sees pending only (accepted/revoked/
  expired excluded); non-admin 403.
- `DELETE …/invitations/{id}`: admin revokes a pending invite → status `revoked`,
  no longer listed; revoking accepted → 409; cross-workspace id → 404; non-admin
  → 403.
- Token: created invite token matches `token_urlsafe` length/charset, not a UUID;
  accept-by-token still works.
- Email: mock the Supabase admin call — new email → `email_sent=true`,
  `redirect_to` carries the token; existing-user error → invite still 201,
  `email_sent=false`, `accept_url` present; generic email error → 201,
  `email_sent=false`. No real network in tests.

## Out of scope (YAGNI)
Resend-invitation, invitation expiry cron, per-invite custom messages, dedicated
transactional email for existing users, seat/quota limits.
