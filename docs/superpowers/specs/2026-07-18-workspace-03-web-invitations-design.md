# Workspace experience — Sub-project 3: Web invitations send/manage

Status: Approved 2026-07-18 · Part 3 of 4 · Depends on Part 1 (cloud foundation)

## Goal

Give workspace admins a web UI to send invitations, see pending ones, and revoke
them — closing the gap where the create/accept backend exists but no screen ever
calls create. Uses the Part 1 endpoints (create with email, list, revoke).

## Where it lives

A **Members / People** section on the workspace view. Current
`w/[workspaceId]/page.tsx` already loads `/workspaces/{id}/members` read-only
(`page.tsx:12`). Add an admin-only management area there (or a dedicated
`w/[workspaceId]/members` route if the page is getting large — split if it grows
past a comfortable size). The invite UI is visible only when the current user's
role in the active workspace is `admin`; members see the roster read-only.

## Components

### Send-invite form
Email input + role select (`member` | `admin`, default `member`) + Send button.
On submit → `POST /workspaces/{id}/invitations` (Part 1 response:
`{invitation, accept_url, email_sent}`). On success:
- `email_sent === true` → toast/inline "Invitation emailed to {email}", refresh
  the pending list.
- `email_sent === false` → show the `accept_url` with a copy button and a note:
  "Couldn't email this address automatically (they may already have an account).
  Share this link with them." This is the honest existing-user path from Part 1.
- Validation: basic email format before submit; surface backend 4xx inline.

### Pending-invitations list
`GET /workspaces/{id}/invitations` (Part 1). Each row: email, role, invited-by,
expiry, and a **Revoke** button → `DELETE /workspaces/{id}/invitations/{id}`,
then refresh. Empty state when none pending.

### Members roster
Existing read-only member list stays; sits alongside the invite UI. (No
remove-member / change-role in this scope — see YAGNI.)

## Data flow
- `apiFetch` bindings in `lib/api.ts` (or the hooks layer) for create/list/revoke.
- Role check: the active workspace's membership role. Fetch the caller's role
  from `/workspaces/{id}/members` (already loaded) matched to the auth user id,
  or a dedicated `role` on the membership if available. Gate the UI on
  `role === "admin"`.
- All three calls are membership/admin-scoped server-side (Part 1); the UI gate
  is UX, not the security boundary.

## Error handling
- Non-admin who reaches the endpoint → 403 (server); UI simply doesn't render the
  controls for them.
- Revoke of an already-accepted/expired invite → 409 surfaced inline; refresh
  list.
- Create with a duplicate pending email → surface the backend's response (Part 1
  defines behavior; if it allows duplicates, the list just shows both — no
  special-casing here).

## Testing
`tsc --noEmit` + `next build` clean. Manual: as admin, send an invite (both the
emailed and copy-link branches), see it appear pending, revoke it, confirm it
disappears; as a non-admin member, confirm the invite controls are absent and the
roster is read-only.

## Out of scope (YAGNI)
Remove-member, change-role, resend-invite, bulk invite, invite-by-link
(shareable join link without a target email), seat limits.
