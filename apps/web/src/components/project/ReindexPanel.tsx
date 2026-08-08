"use client";

import { useState } from "react";
import { reindexProject } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function ReindexPanel({ projectId }: { projectId: string }) {
  const { authHeaders } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [enqueued, setEnqueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setEnqueued(null);
    try {
      const res = await reindexProject(projectId, authHeaders());
      setEnqueued(res.enqueued);
      setConfirming(false);
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
          runs and there is nothing to poll. */}
      {enqueued !== null && (
        <p className="mt-2 text-sm text-slate-600">{enqueued} items queued for indexing.</p>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
