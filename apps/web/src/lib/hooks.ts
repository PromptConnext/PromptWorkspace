"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth";

export interface CloudGetOptions {
  // Silently re-fetch when the tab/window regains focus or visibility.
  refreshOnFocus?: boolean;
  // Silently re-fetch on this interval (ms). Paused while the page is hidden.
  pollMs?: number;
}

interface FetchState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
  // True while a background revalidate() is in flight. Never touches `loading`.
  refreshing: boolean;
  // Set when a background revalidate failed; `data` still holds the last good
  // value and `error` is left alone so callers can keep rendering content.
  refreshError: string | null;
  // Epoch ms of the last successful load (initial or background), or null.
  lastUpdated: number | null;
  // Background refetch: no `loading`, no data/error clearing, and a no-op while
  // another request is already in flight.
  revalidate: () => void;
}

// Generic GET hook: re-fetches when `path` changes or the caller's identity
// becomes available. `enabled=false` skips the request (e.g. while a route
// param isn't resolved yet). `options` opt into silent background refreshes.
export function useCloudGet<T>(
  path: string | null,
  enabled = true,
  options: CloudGetOptions = {},
): FetchState<T> {
  const { authHeaders, user } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const { refreshOnFocus = false, pollMs } = options;

  // Bumped whenever the primary effect restarts or the hook unmounts, so a
  // background response for a stale path/user is dropped.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const authRef = useRef(authHeaders);
  authRef.current = authHeaders;
  const active = !!path && enabled && !!user;

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  const revalidate = useCallback(() => {
    if (!path || !active || inFlight.current) return;
    const gen = generation.current;
    inFlight.current = true;
    setRefreshing(true);
    apiFetch<T>(path, authRef.current())
      .then((result) => {
        if (gen !== generation.current) return;
        setData(result);
        setRefreshError(null);
        setLastUpdated(Date.now());
      })
      .catch((err: Error) => {
        if (gen !== generation.current) return;
        setRefreshError(err.message);
      })
      .finally(() => {
        if (gen !== generation.current) return;
        inFlight.current = false;
        setRefreshing(false);
      });
  }, [path, active]);

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
        if (cancelled) return;
        setData(result);
        setRefreshError(null);
        setLastUpdated(Date.now());
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      // Invalidate any background request tied to the previous run.
      generation.current += 1;
      inFlight.current = false;
      setRefreshing(false);
    };
    // authHeaders() is stable per user/token via useCallback in AuthProvider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, user, nonce]);

  useEffect(() => {
    if (!active || !refreshOnFocus) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") revalidate();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, refreshOnFocus, revalidate]);

  useEffect(() => {
    if (!active || !pollMs || pollMs <= 0) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") revalidate();
    }, pollMs);
    return () => clearInterval(id);
  }, [active, pollMs, revalidate]);

  // Drop in-flight background results after unmount.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return { data, error, loading, refetch, refreshing, refreshError, lastUpdated, revalidate };
}
