"use client";

// Active-workspace context: holds the caller's memberships and the currently
// selected workspace, persisting the selection so it survives reloads (the
// "remember last" gate behavior). Mirrors lib/auth.tsx's provider shape.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth";
import type { Workspace } from "./types";

const ACTIVE_KEY = "pz_active_workspace";
// Memberships are cached per user id so a reload can paint workspace names
// immediately instead of showing raw ids until /workspaces answers. Keying by
// user keeps one account's roster from surfacing under another's session.
const CACHE_KEY_PREFIX = "pz_memberships:";

function cacheKey(userId: string) {
  return `${CACHE_KEY_PREFIX}${userId}`;
}

function readCachedMemberships(userId: string): Workspace[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as Workspace[]) : [];
  } catch {
    return [];
  }
}

interface WorkspaceContextValue {
  memberships: Workspace[];
  activeWorkspace: Workspace | null;
  loading: boolean;
  error: string | null;
  setActiveWorkspace: (id: string) => void;
  clearActiveWorkspace: () => void;
  refetch: () => void;
  createWorkspace: (name: string) => Promise<Workspace>;
  /** Display name for any workspace the caller belongs to; null while unknown. */
  workspaceName: (id: string) => string | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading, authHeaders } = useAuth();
  const [memberships, setMemberships] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Restore the persisted selection once, on the client.
  useEffect(() => {
    if (typeof window !== "undefined") setActiveId(localStorage.getItem(ACTIVE_KEY));
  }, []);

  // Load memberships whenever the signed-in user changes. The cached roster
  // seeds state first so names render on the very first paint after a reload.
  useEffect(() => {
    // Wait for auth to settle: a null user during restore is "unknown", not
    // "signed out", and scrubbing there would throw away the cache on reload.
    if (authLoading) return;
    if (!user) {
      setMemberships([]);
      setLoading(false);
      // Signed out: drop every cached roster so the next account on this
      // browser never sees a previous one's workspace names.
      if (typeof window !== "undefined") {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith(CACHE_KEY_PREFIX)) localStorage.removeItem(key);
        }
      }
      return;
    }
    let cancelled = false;
    const cached = readCachedMemberships(user.id);
    if (cached.length) setMemberships(cached);
    setLoading(true);
    setError(null);
    apiFetch<Workspace[]>("/workspaces", authHeaders())
      .then((ws) => {
        if (cancelled) return;
        setMemberships(ws);
        try {
          localStorage.setItem(cacheKey(user.id), JSON.stringify(ws));
        } catch {
          // A full or unavailable localStorage only costs the first-paint name.
        }
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
  }, [user, authLoading, nonce]);

  const setActiveWorkspace = useCallback((id: string) => {
    setActiveId(id);
    if (typeof window !== "undefined") localStorage.setItem(ACTIVE_KEY, id);
  }, []);

  const clearActiveWorkspace = useCallback(() => {
    setActiveId(null);
    if (typeof window !== "undefined") localStorage.removeItem(ACTIVE_KEY);
  }, []);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const createWorkspace = useCallback(
    async (name: string) => {
      const ws = await apiFetch<Workspace>("/workspaces", authHeaders(), {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setMemberships((prev) => [...prev, ws]);
      setActiveWorkspace(ws.id);
      return ws;
    },
    [authHeaders, setActiveWorkspace],
  );

  // Derived: only resolve to a workspace the user is actually a member of, so a
  // stale persisted id (left/removed workspace) silently falls back to null.
  const activeWorkspace = useMemo(
    () => memberships.find((w) => w.id === activeId) ?? null,
    [memberships, activeId],
  );

  const workspaceName = useCallback(
    (id: string) => memberships.find((w) => w.id === id)?.name ?? null,
    [memberships],
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
      createWorkspace,
      workspaceName,
    }),
    [
      memberships,
      activeWorkspace,
      loading,
      error,
      setActiveWorkspace,
      clearActiveWorkspace,
      refetch,
      createWorkspace,
      workspaceName,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}

// Label for a workspace in headers and breadcrumbs. Reads the roster the
// provider already holds — no per-page fetch, so the name is stable across
// navigation and present on the first paint after a reload. Falls back to a
// generic word rather than the raw id, which is noise to a reader.
export function useWorkspaceName(id: string, fallback = "Workspace"): string {
  const { workspaceName } = useWorkspace();
  return workspaceName(id) ?? fallback;
}
