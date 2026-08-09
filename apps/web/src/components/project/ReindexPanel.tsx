"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getIndexStatus, reindexProject } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { IndexStatus } from "@/lib/types";

const POLL_MS = 2000;
// Give up after this many consecutive polls with no change in queue depth —
// the counter is reset by the effect below every time `pending` actually
// moves, so this bounds "stuck", not "slow". Without it a permanently wedged
// worker would leave every open settings tab polling until the tab closes.
const MAX_POLLS_WITHOUT_PROGRESS = 150; // ~5 minutes at POLL_MS

function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
    />
  );
}

export function ReindexPanel({ projectId }: { projectId: string }) {
  const { authHeaders } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [enqueued, setEnqueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const pollsLeft = useRef(MAX_POLLS_WITHOUT_PROGRESS);

  // Every number here comes straight from the server (indexed_chunks,
  // indexable_nodes, embed_model, pending_jobs) — no interpolation, no
  // estimate. That's what makes it safe to poll this instead of animating a
  // fake progress bar: the counts either visibly moved or they didn't.
  const refreshStatus = useCallback(async () => {
    try {
      const next = await getIndexStatus(projectId, authHeaders());
      setStatus(next);
    } catch {
      // Status is a nice-to-have next to the reindex button itself; a
      // member without permission or a transient failure here shouldn't
      // block the reindex flow, so just leave the last-known status in place.
    } finally {
      setLoading(false);
    }
    // authHeaders() is stable per user/token (useCallback in AuthProvider) —
    // see TaskBoard.tsx for the same pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const pending = status?.pending_jobs ?? 0;

  // Poll only while this project actually has jobs in flight, and stop the
  // moment the queue is empty. Re-running on every change of `pending` is
  // what refreshes the stuck-budget: real progress buys more time, a frozen
  // depth doesn't.
  useEffect(() => {
    if (pending <= 0) return;
    pollsLeft.current = MAX_POLLS_WITHOUT_PROGRESS;
    const id = setInterval(() => {
      if (pollsLeft.current <= 0) {
        clearInterval(id);
        return;
      }
      pollsLeft.current -= 1;
      refreshStatus();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pending, refreshStatus]);

  const busy = loading || running || pending > 0;

  async function run() {
    setRunning(true);
    setError(null);
    setEnqueued(null);
    try {
      const res = await reindexProject(projectId, authHeaders());
      setEnqueued(res.enqueued);
      setConfirming(false);
      // "Queued" isn't "indexed" — re-fetch so the operator can see the queue
      // depth and, from there, whether it actually drains.
      await refreshStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section id="assistant-index" className="mt-10">
      <h2 className="text-lg font-medium text-slate-900">Assistant index</h2>
      <p className="mt-1 text-sm text-slate-600">
        Re-embeds this project&apos;s requirements, specs, tasks and planning documents. Needed
        after changing the workspace&apos;s embedding model.
      </p>

      {/* First load gets a spinner rather than nothing: the counts below are
          the whole basis for deciding whether a reindex is even needed, so an
          empty gap invites exactly the blind button press this panel should
          prevent. */}
      {loading && (
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-500">
          <Spinner label="Loading index status" />
          Checking index status…
        </p>
      )}

      {/* Current index state, read fresh from storage every time — not
          derived from the enqueue response above. This is the only honest
          answer to "did the reindex actually do anything." */}
      {!loading && status && (
        <p className="mt-2 text-sm text-slate-600">
          {status.indexed_chunks} chunk{status.indexed_chunks === 1 ? "" : "s"} indexed
          {status.embed_model ? ` with ${status.embed_model}` : ""} · {status.indexable_nodes}{" "}
          item{status.indexable_nodes === 1 ? "" : "s"} indexable
        </p>
      )}

      {/* Live queue depth, measured server-side (app/rag/queue.py keeps a
          per-project in-flight count). This is the difference between "wait"
          and "something is wrong" — and the reason the button is disabled
          below rather than inviting a second, duplicate sweep. */}
      {pending > 0 && (
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
          <Spinner label="Indexing in progress" />
          Indexing… {pending} item{pending === 1 ? "" : "s"} left in the queue.
        </p>
      )}

      {/* A job that was discarded rather than deferred (no embedding model
          configured, no GitHub token, an embedding call that raised) leaves
          the chunk count frozen at whatever it was. Only this line can say
          why, so it stays visible until a later job succeeds and the server
          clears it. */}
      {!loading && status?.last_error && (
        <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">Last indexing error ({status.last_error.code}):</span>{" "}
          {status.last_error.message}
        </p>
      )}

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending > 0 ? "Indexing…" : "Reindex project"}
        </button>
      ) : (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">
            This makes one embedding call per requirement, spec, task and planning document in this
            project.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={run}
              disabled={running}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {running ? "Queuing…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={running}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* "Queued", never "indexed" — the endpoint returns before any embedding
          runs. aria-live so a screen-reader user waiting on the async result
          gets it announced instead of having to poll the page themselves. */}
      {enqueued !== null && (
        <p className="mt-2 text-sm text-slate-600" aria-live="polite">
          {enqueued} items queued for indexing.
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm text-red-600" aria-live="polite">
          {error}
        </p>
      )}
    </section>
  );
}
