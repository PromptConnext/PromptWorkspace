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
  createWorkspace: (name: string) => Promise<Workspace>;
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
    // authHeaders() is stable per user/token (useCallback in AuthProvider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setActiveWorkspace],
  );

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
      createWorkspace,
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
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
