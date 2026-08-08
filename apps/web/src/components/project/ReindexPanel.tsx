"use client";

import { useCallback, useEffect, useState } from "react";
import { getIndexStatus, reindexProject } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { IndexStatus } from "@/lib/types";

export function ReindexPanel({ projectId }: { projectId: string }) {
  const { authHeaders } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [enqueued, setEnqueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);

  // Every number here comes straight from the server (indexed_chunks,
  // indexable_nodes, embed_model) — no interpolation, no estimate. This is
  // what makes it safe to re-fetch after a reindex rather than fake a
  // progress bar: the count either visibly moved or it didn't.
  const refreshStatus = useCallback(async () => {
    try {
      const next = await getIndexStatus(projectId, authHeaders());
      setStatus(next);
    } catch {
      // Status is a nice-to-have next to the reindex button itself; a
      // member without permission or a transient failure here shouldn't
      // block the reindex flow, so just leave the last-known status in place.
    }
    // authHeaders() is stable per user/token (useCallback in AuthProvider) —
    // see TaskBoard.tsx for the same pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  async function run() {
    setRunning(true);
    setError(null);
    setEnqueued(null);
    try {
      const res = await reindexProject(projectId, authHeaders());
      setEnqueued(res.enqueued);
      setConfirming(false);
      // "Queued" isn't "indexed" — re-fetch so the operator can see whether
      // the queue actually drained, instead of trusting the enqueue count.
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

      {/* Current index state, read fresh from storage every time — not
          derived from the enqueue response above. This is the only honest
          answer to "did the reindex actually do anything." */}
      {status && (
        <p className="mt-2 text-sm text-slate-600">
          {status.indexed_chunks} chunk{status.indexed_chunks === 1 ? "" : "s"} indexed
          {status.embed_model ? ` with ${status.embed_model}` : ""} · {status.indexable_nodes}{" "}
          item{status.indexable_nodes === 1 ? "" : "s"} indexable
        </p>
      )}

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="mt-3 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400"
        >
          Reindex project
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
          runs and there is nothing to poll. aria-live so a screen-reader user
          waiting on the async result gets it announced instead of having to
          poll the page themselves. */}
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
