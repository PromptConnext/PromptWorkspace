# Web auth pages — login, register, forgot/reset password

Status: Approved 2026-07-17

## Goal

Give `apps/web` a complete self-service auth surface: sign in, sign up, request a
password reset, and set a new password. Today only `/login` exists. All auth is
**client-side Supabase JS** (`lib/auth.tsx`) toggled by `AUTH_MODE` (`stub` |
`supabase`) — the web app has no server routes, so nothing here runs on the
server.

## Scope

In: four auth routes under a shared, redesigned auth shell; three new methods on
the auth context. Out (YAGNI): OAuth/social providers, magic-link, server-side
auth routes, custom rate-limiting (Supabase enforces its own).

## Auth context (`lib/auth.tsx`)

Add to `AuthContextValue` and the provider:

- `signUpSupabase(email, password)` → `supabase.auth.signUp({ email, password })`
- `sendPasswordReset(email)` → `supabase.auth.resetPasswordForEmail(email, { redirectTo: \`${origin}/reset-password\` })`
- `updatePassword(newPassword)` → `supabase.auth.updateUser({ password })`

The existing `onAuthStateChange` handler already establishes a session from the
`PASSWORD_RECOVERY` event, so the reset page only needs `updatePassword`.

## Shared shell

A route group `app/(auth)/` with a `layout.tsx` that renders a centered card:
PromptConnext wordmark, card surface, consistent typography and spacing, indigo
accent on the existing slate palette (light-first — the app body is fixed light).
`/login` moves into this group unchanged in logic. URLs are unaffected (route
groups don't alter the path).

Small shared primitives live in `components/auth/`: a styled text `Field`, a
`SubmitButton` with pending state, and an `AuthCard` heading/subtext wrapper.

## Routes

Every page is `"use client"`. In `stub` mode each of register / forgot / reset
calls `router.replace("/login")` immediately (passwords are meaningless there).

| Route | Behavior |
|---|---|
| `/login` | Moved into the shell; logic unchanged. Cross-links to register + forgot. |
| `/register` | email + password + confirm → client validation → `signUpSupabase` → **"Check your email"** confirmation screen (respects Supabase email-confirmation default). |
| `/forgot-password` | email → `sendPasswordReset` → generic "if that account exists, a reset link was sent" screen. Same copy regardless of whether the email is registered — no account enumeration. |
| `/reset-password` | new password + confirm → `updatePassword` → redirect `/login`. If no recovery session is present, show a "link expired or invalid" state with a link back to forgot-password. |

## Validation & errors

Client-side before hitting Supabase: email format, password length ≥ 8,
confirm-matches-password. Supabase errors surfaced inline in red, matching the
current login form's `error` pattern.

## Security notes

- Forgot-password must not reveal account existence (uniform response copy).
- `reset-password` relies on the recovery session Supabase mints from the email
  link; if absent, never expose the update form.
- `AUTH_MODE` continues to fail closed to `supabase` (per `config.ts`).
