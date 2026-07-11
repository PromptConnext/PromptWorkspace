"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth";

interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

// Generic GET hook: re-fetches when `path` changes or the caller's identity
// becomes available. `enabled=false` skips the request (e.g. while a route
// param isn't resolved yet).
export function useCloudGet<T>(path: string | null, enabled = true): FetchState<T> {
  const { authHeaders, user } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!path || !enabled || !user) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<T>(path, authHeaders())
      .then((result) => {
        if (!cancelled) setData(result);
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
    // authHeaders() is stable per user/token via useCallback in AuthProvider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, user, nonce]);

  return { data, error, loading, refetch };
}
