# Workspace Part 2 — Web Gate + Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give `apps/web` a persisted active-workspace context, a gate at `/` that auto-enters a single membership / auto-resumes a remembered choice / shows a picker for many, and workspace-scoped project loads via the Part 1 endpoint.

**Architecture:** A client `WorkspaceProvider` (mirroring `lib/auth.tsx`) holds memberships + the active workspace, persisting the selection in `localStorage`. The home route `/` becomes a gate that resolves and redirects into `/w/{id}`; `/w/[workspaceId]` sets the active workspace from its URL param. A switcher in `TopBar` lets users change scope. `apps/web` has **no test runner** — every task's gate is `tsc --noEmit` + `next build` clean (all routes present) plus the stated manual check.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind, `localStorage`.

## Global Constraints

- Persist the active workspace id under `localStorage` key `pz_active_workspace`. A persisted id is honored only if it is still a current membership (stale ids ignored).
- Gate resolution: 0 memberships → empty state; exactly 1 → auto-enter (redirect to its workspace); >1 with a valid remembered id → auto-resume (redirect); >1 with none → picker. Switcher always available.
- Projects load via `GET /workspaces/{activeWorkspace.id}/projects` (Part 1), replacing the fetch-all-`/projects`-and-filter at `w/[workspaceId]/page.tsx`.
- No workspace-creation UI on web (stays desktop). Keep the existing "ask an admin / create from desktop" empty-state copy.
- Match existing component style (Tailwind classes, `"use client"`, the `useCloudGet`/`apiFetch` + `authHeaders()` pattern). Web has no test runner — do not add one; verify with `tsc` + `next build`.

---

### Task 1: WorkspaceProvider + context

**Files:**
- Create: `apps/web/src/lib/workspace.tsx`
- Modify: `apps/web/src/app/layout.tsx` (mount the provider inside `AuthProvider`)

**Interfaces:**
- Produces `useWorkspace(): WorkspaceContextValue` with:
  - `memberships: Workspace[]`
  - `activeWorkspace: Workspace | null` (derived: the membership whose id === the persisted/selected id)
  - `loading: boolean`, `error: string | null`
  - `setActiveWorkspace(id: string): void` (persists to `localStorage`)
  - `clearActiveWorkspace(): void`
  - `refetch(): void`

- [ ] **Step 1: Create the provider**

```tsx
// apps/web/src/lib/workspace.tsx
"use client";

// Active-workspace context: holds the caller's memberships and the currently
// selected workspace, persisting the selection so it survives reloads (the
// "remember last" gate behavior). Mirrors lib/auth.tsx's provider shape.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth";
import type { Workspace } from "./types";

const ACTIVE_KEY = "pz_active_workspace";

interface WorkspaceContextValue {
  memberships: Workspace[];
  activeWorkspace: Workspace | null;
  loading: boolean;
  error: string | null;
  setActiveWorkspace: (id: string) => void;
  clearActiveWorkspace: () => void;
  refetch: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user, authHeaders } = useAuth();
  const [memberships, setMemberships] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Restore the persisted selection once, on the client.
  useEffect(() => {
    if (typeof window !== "undefined") setActiveId(localStorage.getItem(ACTIVE_KEY));
  }, []);

  // Load memberships whenever the signed-in user changes.
  useEffect(() => {
    if (!user) {
      setMemberships([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<Workspace[]>("/workspaces", authHeaders())
      .then((ws) => {
        if (!cancelled) setMemberships(ws);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // authHeaders() is stable per user/token (useCallback in AuthProvider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, nonce]);

  const setActiveWorkspace = useCallback((id: string) => {
    setActiveId(id);
    if (typeof window !== "undefined") localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  const clearActiveWorkspace = useCallback(() => {
    setActiveId(null);
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_KEY);
  }, []);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  // Derived: only resolve to a workspace the user is actually a member of, so a
  // stale persisted id (left/removed workspace) silently falls back to null.
  const activeWorkspace = useMemo(
    () => memberships.find((w) => w.id === activeId) ?? null,
    [memberships, activeId],
  );

  const value = useMemo(
    () => ({
      memberships,
      activeWorkspace,
      loading,
      error,
      setActiveWorkspace,
      clearActiveWorkspace,
      refetch,
    }),
    [memberships, activeWorkspace, loading, error, setActiveWorkspace, clearActiveWorkspace, refetch],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
```

- [ ] **Step 2: Mount the provider in the root layout**

In `apps/web/src/app/layout.tsx`, import and nest it inside `AuthProvider`:

```tsx
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
// ...
        <AuthProvider>
          <WorkspaceProvider>{children}</WorkspaceProvider>
        </AuthProvider>
```

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean; all existing routes still present.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/workspace.tsx apps/web/src/app/layout.tsx
git commit -m "feat(web): WorkspaceProvider — persisted active-workspace context"
```

---

### Task 2: Workspace gate at `/`

**Files:**
- Create: `apps/web/src/components/WorkspaceGate.tsx`
- Modify: `apps/web/src/app/page.tsx` (render the gate instead of the inline switcher)

**Interfaces:**
- Consumes: `useWorkspace` (Task 1).
- Produces: `WorkspaceGate` — resolves the active workspace and redirects to `/w/{id}`, or renders the picker/empty/loading state. Used only by `/`.

- [ ] **Step 1: Create the gate**

```tsx
// apps/web/src/components/WorkspaceGate.tsx
"use client";

// The `/` gate: resolves which workspace the session should enter.
// - 0 memberships  -> empty state (get invited / create from desktop)
// - exactly 1      -> auto-enter it
// - remembered id  -> auto-resume it
// - many, none set -> picker
// Once an active workspace resolves, redirect into /w/{id}; the workspace pages
// own the actual content.

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { useWorkspace } from "@/lib/workspace";

export function WorkspaceGate() {
  const router = useRouter();
  const { memberships, activeWorkspace, loading, error, setActiveWorkspace } = useWorkspace();

  // Auto-enter a single membership (no point showing a one-item picker).
  useEffect(() => {
    if (!loading && !activeWorkspace && memberships.length === 1) {
      setActiveWorkspace(memberships[0].id);
    }
  }, [loading, activeWorkspace, memberships, setActiveWorkspace]);

  // Once resolved (remembered or just auto-entered), redirect into the workspace.
  useEffect(() => {
    if (activeWorkspace) router.replace(`/w/${activeWorkspace.id}`);
  }, [activeWorkspace, router]);

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-red-600">{error}</div>;
  }
  if (activeWorkspace) {
    // redirect in flight
    return <div className="p-6 text-sm text-slate-500">Opening {activeWorkspace.name}…</div>;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Your workspaces</h1>
        {memberships.length === 0 ? (
          <p className="text-sm text-slate-500">
            No workspaces yet. Ask an admin to invite you, or create one from the desktop app.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {memberships.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => setActiveWorkspace(w.id)}
                  className="block w-full rounded border border-slate-200 bg-white px-4 py-3 text-left hover:border-slate-400"
                >
                  <span className="font-medium">{w.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
```

- [ ] **Step 2: Rewrite the home page to use the gate**

Replace the body of `apps/web/src/app/page.tsx` with:

```tsx
"use client";

import { RequireAuth } from "@/components/RequireAuth";
import { WorkspaceGate } from "@/components/WorkspaceGate";

export default function HomePage() {
  return (
    <RequireAuth>
      <WorkspaceGate />
    </RequireAuth>
  );
}
```

(Removes the inline `WorkspaceSwitcher` + its `useCloudGet`/`Link`/`Workspace`/`TopBar` imports — the gate owns that now.)

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean; `/` still present as a static/dynamic route.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/WorkspaceGate.tsx apps/web/src/app/page.tsx
git commit -m "feat(web): workspace gate at / (auto-enter, resume, picker, empty)"
```

---

### Task 3: URL reconciliation, scoped projects, nav switcher

**Files:**
- Modify: `apps/web/src/app/w/[workspaceId]/page.tsx` (set active from URL; scoped projects)
- Modify: `apps/web/src/components/TopBar.tsx` (workspace switcher)

**Interfaces:**
- Consumes: `useWorkspace` (Task 1); `GET /workspaces/{id}/projects` (Part 1).

- [ ] **Step 1: Reconcile active workspace from the URL + scope projects**

In `apps/web/src/app/w/[workspaceId]/page.tsx`, update `WorkspaceHome`:

```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import type { Project, Workspace, WorkspaceMember } from "@/lib/types";

function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { memberships, loading: wsLoading, setActiveWorkspace } = useWorkspace();
  const { data: workspace } = useCloudGet<Workspace>(`/workspaces/${workspaceId}`);
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const { data: projects, error, loading } = useCloudGet<Project[]>(
    `/workspaces/${workspaceId}/projects`,
  );

  // Treat visiting /w/{id} as an explicit selection: if it's a real membership,
  // make it the active workspace; if the memberships are loaded and it is NOT
  // one, bounce to the gate.
  useEffect(() => {
    if (wsLoading) return;
    if (memberships.some((w) => w.id === workspaceId)) {
      setActiveWorkspace(workspaceId);
    } else {
      router.replace("/");
    }
  }, [wsLoading, memberships, workspaceId, setActiveWorkspace, router]);

  return (
    <>
      <TopBar crumbs={[{ label: workspace?.name ?? workspaceId }]} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{workspace?.name ?? "Workspace"}</h1>
          <p className="text-sm text-slate-500">{members?.length ?? 0} member(s)</p>
        </div>

        {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && (projects?.length ?? 0) === 0 && (
          <p className="text-sm text-slate-500">
            No projects yet in this workspace. Link one from the desktop app.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link
                href={`/w/${workspaceId}/p/${p.id}`}
                className="block rounded border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
              >
                <span className="font-medium">{p.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

export default function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <WorkspaceHome workspaceId={workspaceId} />
    </RequireAuth>
  );
}
```

(The client-side `allProjects.filter(...)` is gone; the projects list comes scoped from the server.)

- [ ] **Step 2: Add the workspace switcher to TopBar**

In `apps/web/src/components/TopBar.tsx`, add a switcher that appears when the user has memberships. Use `useWorkspace`; navigating selects + routes to that workspace:

```tsx
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useWorkspace } from "@/lib/workspace";

export function TopBar({ crumbs }: { crumbs?: { label: string; href?: string }[] }) {
  const { user, signOut } = useAuth();
  const { memberships, activeWorkspace, setActiveWorkspace } = useWorkspace();
  const router = useRouter();

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
      <nav className="flex items-center gap-2 text-sm">
        <Link href="/" className="font-semibold text-slate-900">
          PromptConnext
        </Link>
        {memberships.length > 1 && (
          <select
            aria-label="Active workspace"
            className="ml-2 rounded border border-slate-300 px-2 py-1 text-slate-700"
            value={activeWorkspace?.id ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) return;
              setActiveWorkspace(id);
              router.push(`/w/${id}`);
            }}
          >
            {!activeWorkspace && <option value="">Select workspace…</option>}
            {memberships.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        {crumbs?.map((c) => (
          <span key={c.label} className="flex items-center gap-2 text-slate-500">
            <span>/</span>
            {c.href ? (
              <Link href={c.href} className="hover:text-slate-900">
                {c.label}
              </Link>
            ) : (
              <span className="text-slate-900">{c.label}</span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex items-center gap-3 text-sm text-slate-500">
        <span>{user?.email}</span>
        <button onClick={() => void signOut()} className="rounded border border-slate-300 px-2 py-1">
          Sign out
        </button>
      </div>
    </header>
  );
}
```

- [ ] **Step 2 note:** `TopBar` is also rendered by `WorkspaceGate` and `p/[projectId]/page.tsx`. Those already sit under `WorkspaceProvider` (root layout), so `useWorkspace` resolves everywhere `TopBar` mounts — no other change needed. Confirm `p/[projectId]/page.tsx` still typechecks (it imports `TopBar`).

- [ ] **Step 3: Typecheck + build**

Run: `cd apps/web && npx tsc --noEmit && npx next build`
Expected: clean; `/w/[workspaceId]` and `/w/[workspaceId]/p/[projectId]` present.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/src/app/w/[workspaceId]/page.tsx" apps/web/src/components/TopBar.tsx
git commit -m "feat(web): scope projects to active workspace + nav switcher + URL reconciliation"
```

---

## Self-Review notes (for the executor)

- Spec coverage: provider + persistence (Task 1) ✓; gate auto-enter/resume/picker/empty (Task 2) ✓; URL reconciliation + scoped projects + switcher (Task 3) ✓.
- Redirect-loop check: `/` gate redirects to `/w/{id}` only when a workspace resolves; `/w/{id}` redirects to `/` only when the id is NOT a membership (after load). A valid id never bounces back. A signed-out user is caught by `RequireAuth` before either.
- Type consistency: `useWorkspace()` shape identical across Gate, TopBar, and the workspace page. Projects now typed off `GET /workspaces/{id}/projects` (returns `Project[]`, same type as before).
- No test runner in web — gates are `tsc` + `next build`; manual walkthrough per the spec (single→auto-enter, many→picker, reload persists, switcher re-scopes, stale id → gate).
