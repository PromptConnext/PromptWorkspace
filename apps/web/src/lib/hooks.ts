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
  // The same request as `refetch`, named for the Retry button an error line
  // offers after a failed load.
  retry: () => void;
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
  // Replace `data` locally with a value the caller already has (e.g. a
  // mutation response carrying the resource as it now stands), instead of
  // spending a refetch. A request already in flight is dropped so it cannot
  // overwrite the newer value.
  mutate: (next: T) => void;
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

  const mutate = useCallback((next: T) => {
    // Supersede any request in flight (first load or background): its answer
    // predates `next`. The first load's finally still clears `loading`.
    generation.current += 1;
    inFlight.current = false;
    setRefreshing(false);
    setData(next);
    setError(null);
    setRefreshError(null);
    setLastUpdated(Date.now());
  }, []);

  const revalidate = useCallback(() => {
    if (!path || !active || inFlight.current) return;
    const gen = generation.current;
    inFlight.current = true;
    setRefreshing(true);
    apiFetch<T>(path, authRef.current())
      .then((result) => {
        if (gen !== generation.current) return;
        setData(result);
        // A good answer supersedes a failed first load too.
        setError(null);
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
    // A mutate() while this load is out bumps the generation: the answer is
    // then older than the data it would replace.
    const gen = generation.current;
    // Background refreshes stand down while the first load is out.
    inFlight.current = true;
    setLoading(true);
    setError(null);
    apiFetch<T>(path, authHeaders())
      .then((result) => {
        if (cancelled || gen !== generation.current) return;
        setData(result);
        setRefreshError(null);
        setLastUpdated(Date.now());
      })
      .catch((err: Error) => {
        if (!cancelled && gen === generation.current) setError(err.message);
      })
      .finally(() => {
        if (cancelled) return;
        if (gen === generation.current) inFlight.current = false;
        setLoading(false);
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

  return { data, error, loading, refetch, retry: refetch, refreshing, refreshError, lastUpdated, revalidate, mutate };
}
