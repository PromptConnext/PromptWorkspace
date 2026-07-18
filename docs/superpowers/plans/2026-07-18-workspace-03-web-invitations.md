# Workspace Part 3 — Web Invitations Send/Manage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give workspace admins a web UI to send invitations, see pending ones, and revoke them, using the Part 1 endpoints — closing the gap where create/accept exist but no screen ever creates.

**Architecture:** A dedicated `/w/[workspaceId]/members` route (keeps the workspace home focused) composes a read-only roster with an admin-only invite form and pending-invitations list. Admin gating is a UX affordance (the server enforces `require_admin`); the caller's role is derived from the members list. `apps/web` has **no test runner** — every gate is `tsc --noEmit` + `next build` clean plus the stated manual check.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind, `apiFetch`/`useCloudGet`/`authHeaders()`, `navigator.clipboard`.

## Global Constraints

- Uses Part 1 endpoints: `POST /workspaces/{id}/invitations` → `{invitation, accept_url, email_sent}`; `GET /workspaces/{id}/invitations` → pending `Invitation[]`; `DELETE /workspaces/{id}/invitations/{id}` → 204.
- Admin-only UI: derive the caller's role from `GET /workspaces/{id}/members` matched to the auth user id; show invite/revoke controls only when `role === "admin"`. Members see the roster read-only.
- On send: `email_sent === true` → confirmation + refresh; `email_sent === false` → show the `accept_url` with a copy button and a "couldn't email automatically — share this link" note (the existing-user path).
- Match existing component style (`"use client"`, Tailwind, `apiFetch(path, authHeaders(), init)` for mutations, `useCloudGet` for reads).
- No test runner — verify with `tsc` + `next build`. Do not touch dependencies; if `@types/react` errors appear, STOP and report.

---

### Task 1: Types + members route scaffold

**Files:**
- Modify: `apps/web/src/lib/types.ts` (fix `InvitationStatus`, add `InvitationCreateResponse`)
- Create: `apps/web/src/app/w/[workspaceId]/members/page.tsx` (roster + role gating; management panels come in Tasks 2–3)
- Modify: `apps/web/src/app/w/[workspaceId]/page.tsx` (add a "Members" link)

**Interfaces:**
- Produces: `InvitationCreateResponse` type; a members page that computes `isAdmin` and renders the roster, leaving a slot for the invite form + pending list.

- [ ] **Step 1: Fix invitation types**

In `apps/web/src/lib/types.ts`:

```ts
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
```

And after the `Invitation` interface, add:

```ts
export interface InvitationCreateResponse {
  invitation: Invitation;
  accept_url: string;
  email_sent: boolean;
}
```

- [ ] **Step 2: Create the members route (roster + role gate)**

```tsx
// apps/web/src/app/w/[workspaceId]/members/page.tsx
"use client";

import Link from "next/link";
import { use } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Workspace, WorkspaceMember } from "@/lib/types";

function MembersView({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const { data: workspace } = useCloudGet<Workspace>(`/workspaces/${workspaceId}`);
  const { data: members, refetch: refetchMembers } = useCloudGet<WorkspaceMember[]>(
    `/workspaces/${workspaceId}/members`,
  );
  const isAdmin = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspace?.name ?? workspaceId, href: `/w/${workspaceId}` },
          { label: "Members" },
        ]}
      />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Members</h1>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-medium text-slate-500">People</h2>
          <ul className="flex flex-col gap-2">
            {members?.map((m) => (
              <li
                key={m.user_id}
                className="flex items-center justify-between rounded border border-slate-200 bg-white px-4 py-3"
              >
                <span className="font-medium">{m.user_id}</span>
                <span className="text-sm text-slate-500">{m.role}</span>
              </li>
            ))}
          </ul>
        </section>

        {isAdmin && (
          <>
            {/* Task 2 mounts <InviteForm> here */}
            {/* Task 3 mounts <PendingInvitations> here */}
          </>
        )}
        <Link href={`/w/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-900">
          ← Back to workspace
        </Link>
      </main>
    </>
  );
}

export default function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <MembersView workspaceId={workspaceId} />
    </RequireAuth>
  );
}
```

(`refetchMembers` is unused for now but wired for Task 2's post-invite refresh — if the executor prefers, omit it here and add it in Task 2. Leaving it unused would trip `next build`'s lint; so either omit it now or prefix with a comment. Omit it in Step 2 and destructure it in Task 2.)

Correction for Step 2: destructure only what's used now:

```tsx
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
```

- [ ] **Step 3: Link to members from the workspace home**

In `apps/web/src/app/w/[workspaceId]/page.tsx`, in the header row next to the member count, add a link (import `Link` is already present):

```tsx
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{workspace?.name ?? "Workspace"}</h1>
          <div className="flex items-center gap-4">
            <Link
              href={`/w/${workspaceId}/members`}
              className="text-sm text-slate-500 hover:text-slate-900"
            >
              {members?.length ?? 0} member(s)
            </Link>
          </div>
        </div>
```

(Replaces the plain `<p>{members?.length ?? 0} member(s)</p>`.)

- [ ] **Step 4: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean; `/w/[workspaceId]/members` present.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/types.ts "apps/web/src/app/w/[workspaceId]/members/page.tsx" "apps/web/src/app/w/[workspaceId]/page.tsx"
git commit -m "feat(web): members route scaffold + invitation types (revoked, create response)"
```

---

### Task 2: Invite form

**Files:**
- Create: `apps/web/src/components/InviteForm.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/members/page.tsx` (mount the form; add `refetch`)

**Interfaces:**
- Consumes: `POST /workspaces/{id}/invitations` (Part 1). Props `{ workspaceId: string; onInvited: () => void }`.

- [ ] **Step 1: Create the invite form**

```tsx
// apps/web/src/components/InviteForm.tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { InvitationCreateResponse, Role } from "@/lib/types";

export function InviteForm({
  workspaceId,
  onInvited,
}: {
  workspaceId: string;
  onInvited: () => void;
}) {
  const { authHeaders } = useAuth();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setManualLink(null);
    setCopied(false);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    try {
      const res = await apiFetch<InvitationCreateResponse>(
        `/workspaces/${workspaceId}/invitations`,
        authHeaders(),
        { method: "POST", body: JSON.stringify({ email, role }) },
      );
      setEmail("");
      if (!res.email_sent) {
        setManualLink(res.accept_url);
      }
      onInvited();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!manualLink) return;
    await navigator.clipboard.writeText(manualLink);
    setCopied(true);
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-medium text-slate-500">Invite someone</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-700">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            className="rounded border border-slate-300 px-3 py-2"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-700">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded border border-slate-300 px-3 py-2"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-60"
        >
          {pending ? "Sending…" : "Send invite"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {manualLink && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">
            Couldn&apos;t email this address automatically (they may already have an account).
            Share this invite link with them:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white px-2 py-1 text-xs">
              {manualLink}
            </code>
            <button
              type="button"
              onClick={copyLink}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it in the members route**

In `apps/web/src/app/w/[workspaceId]/members/page.tsx`: add a `refetch` for members and mount the form inside the `isAdmin` block:

```tsx
import { InviteForm } from "@/components/InviteForm";
// ...
  const { data: members, refetch: refetchMembers } = useCloudGet<WorkspaceMember[]>(
    `/workspaces/${workspaceId}/members`,
  );
// ...
        {isAdmin && (
          <>
            <InviteForm workspaceId={workspaceId} onInvited={refetchMembers} />
            {/* Task 3 mounts <PendingInvitations> here */}
          </>
        )}
```

(Members won't change on invite — a pending invite isn't a member yet — but `refetchMembers` is a harmless no-op refresh; Task 3 replaces `onInvited` with the pending-list refetch, which is the one that matters. For this task, pass `refetchMembers`.)

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/InviteForm.tsx "apps/web/src/app/w/[workspaceId]/members/page.tsx"
git commit -m "feat(web): admin invite form with email-sent + copy-link fallback"
```

---

### Task 3: Pending invitations list + revoke

**Files:**
- Create: `apps/web/src/components/PendingInvitations.tsx`
- Modify: `apps/web/src/app/w/[workspaceId]/members/page.tsx` (mount it; route `onInvited` to its refetch)

**Interfaces:**
- Consumes: `GET /workspaces/{id}/invitations`, `DELETE /workspaces/{id}/invitations/{id}` (Part 1). Exposes a `refetch` the invite form triggers on send.

- [ ] **Step 1: Create the pending-invitations component**

```tsx
// apps/web/src/components/PendingInvitations.tsx
"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Invitation } from "@/lib/types";

export function PendingInvitations({
  workspaceId,
  registerRefetch,
}: {
  workspaceId: string;
  registerRefetch?: (fn: () => void) => void;
}) {
  const { authHeaders } = useAuth();
  const { data: invitations, refetch } = useCloudGet<Invitation[]>(
    `/workspaces/${workspaceId}/invitations`,
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Let the parent trigger a refresh (e.g. after an invite is sent).
  if (registerRefetch) registerRefetch(refetch);

  async function revoke(id: string) {
    setError(null);
    setBusyId(id);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invitations/${id}`, authHeaders(), {
        method: "DELETE",
      });
      refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-medium text-slate-500">Pending invitations</h2>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {(invitations?.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">No pending invitations.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {invitations?.map((inv) => (
            <li
              key={inv.id}
              className="flex items-center justify-between rounded border border-slate-200 bg-white px-4 py-3"
            >
              <span>
                <span className="font-medium">{inv.email}</span>{" "}
                <span className="text-sm text-slate-500">({inv.role})</span>
              </span>
              <button
                type="button"
                disabled={busyId === inv.id}
                onClick={() => revoke(inv.id)}
                className="rounded border border-slate-300 px-2 py-1 text-sm text-red-600 disabled:opacity-60"
              >
                {busyId === inv.id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

> The `registerRefetch` prop passes the child's `refetch` up so the invite form can refresh the pending list on send. If the executor finds the render-phase `registerRefetch(refetch)` call awkward (it runs each render), an acceptable equivalent is to lift both components under a small parent that owns a shared `nonce` and passes it as a `key` or refetch trigger — but the simple ref-callback is fine here since `refetch` is a stable `useCallback` from `useCloudGet`. Do NOT call it inside render if it causes a setState-in-render warning; wrap in `useEffect(() => registerRefetch?.(refetch), [registerRefetch, refetch])` instead.

- [ ] **Step 2: Wire both panels in the members route**

Replace the `isAdmin` block so the invite form's `onInvited` refreshes the pending list:

```tsx
import { InviteForm } from "@/components/InviteForm";
import { PendingInvitations } from "@/components/PendingInvitations";
import { useRef } from "react";
// ...inside MembersView:
  const refetchInvitesRef = useRef<() => void>(() => {});
// ...
        {isAdmin && (
          <>
            <InviteForm
              workspaceId={workspaceId}
              onInvited={() => refetchInvitesRef.current()}
            />
            <PendingInvitations
              workspaceId={workspaceId}
              registerRefetch={(fn) => {
                refetchInvitesRef.current = fn;
              }}
            />
          </>
        )}
```

And in `PendingInvitations`, use the effect form to register:

```tsx
import { useEffect, useState } from "react";
// ...
  useEffect(() => {
    if (registerRefetch) registerRefetch(refetch);
  }, [registerRefetch, refetch]);
```

(Remove the render-phase `if (registerRefetch) registerRefetch(refetch);` line.)

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean; `/w/[workspaceId]/members` present.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/PendingInvitations.tsx "apps/web/src/app/w/[workspaceId]/members/page.tsx"
git commit -m "feat(web): pending-invitations list with revoke"
```

---

## Self-Review notes (for the executor)

- Spec coverage: send form with email/role + email_sent/copy-link branches (Task 2) ✓; pending list + revoke (Task 3) ✓; admin-gated, roster read-only for members (Task 1) ✓; types reconciled (Task 1) ✓.
- Security: the UI `isAdmin` gate is UX only — every endpoint is `require_admin`/`require_workspace` server-side (Part 1). A non-admin who forges a request still gets 403.
- The invite→refresh wiring uses a ref so the form refreshes the pending list without a shared parent-state refactor. `refetch` from `useCloudGet` is stable (useCallback).
- No test runner — gates are `tsc` + `next build`; manual: as admin send an invite (both emailed + copy-link branches), see it pending, revoke it; as a member, confirm no invite/revoke controls.
