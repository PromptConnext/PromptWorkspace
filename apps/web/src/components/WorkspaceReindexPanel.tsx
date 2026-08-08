"use client";

import { useState } from "react";
import { reindexWorkspace } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIsWorkspaceAdmin } from "@/lib/workspace";
import type { WorkspaceReindexResult } from "@/lib/types";

// Workspace-wide sibling of components/project/ReindexPanel.tsx. Recovering
// from a model swapped in place, an embedding dimension change, a failed
// batch, or plain doubt about freshness used to mean visiting every
// project's settings page by hand — this fires the same backfill sweep
// (apps/cloud/app/api/assistant.py::reindex_workspace) across every project
// in the workspace at once.
//
// Deliberately not a generalised ReindexPanel: there is no
// GET /workspaces/{id}/assistant/index-status endpoint (only a per-project
// one), so this panel has no "current index state" section to render or
// refresh — it only ever shows the one-shot enqueue result the server
// returns. Forcing a shared component would mean threading an optional
// status-fetch through a component that project settings would never use.
export function WorkspaceReindexPanel({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WorkspaceReindexResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Self-gated (same posture as AssistantPanel's admin-only reindex
  // control) rather than trusting the settings page's own `isAdmin` wrap
  // alone: the server enforces this too (require_admin), but a member who
  // reaches this component some other way should never see the button.
  if (!isAdmin) return null;

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await reindexWorkspace(workspaceId, authHeaders());
      setResult(res);
      setConfirming(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">Reindex workspace</h2>
      <p className="mb-4 text-xs text-slate-500">
        Re-embeds every project&apos;s requirements, specs, tasks and planning documents across
        the whole workspace. Needed after swapping the embedding model in place, changing its
        dimensions, or recovering from a failed batch — the per-project reindex on each
        project&apos;s settings page covers one project at a time; this covers all of them.
      </p>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-slate-400"
        >
          Reindex workspace
        </button>
      ) : (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <p className="text-slate-700">
            This makes one embedding call per requirement, spec, task and planning document in
            every project in this workspace.
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

      {/* "Queued", never "indexed" — every number here is the server's, not
          an estimate, and there is no workspace-level status endpoint to
          poll for completion. */}
      {result && (
        <p className="mt-2 text-sm text-slate-600" aria-live="polite">
          {result.enqueued} item{result.enqueued === 1 ? "" : "s"} queued across{" "}
          {result.projects_swept} project{result.projects_swept === 1 ? "" : "s"}.
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
