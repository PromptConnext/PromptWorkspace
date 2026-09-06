"use client";

import { useCloudGet } from "@/lib/hooks";
import type { DeploymentStatus, ProjectGraph, TaskStatus } from "@/lib/types";

const DONE: TaskStatus[] = ["implemented", "verified"];

/**
 * Tasks that are in a build that actually published (ADR 0023 decision 5).
 *
 * Only `live` rows count. A failed build's task set is real history and is
 * shown as such in the Preview tab, but "the version you can open" must mean
 * exactly that — counting a build nobody can reach would be the drift this
 * whole feature exists to avoid.
 */
export function shippedTaskIds(status: DeploymentStatus | null): Set<string> {
  const ids = new Set<string>();
  for (const deploy of status?.recent ?? []) {
    if (deploy.state !== "live") continue;
    for (const task of deploy.tasks) ids.add(task.id);
  }
  return ids;
}

export function ProgressRollup({ graph, projectId }: { graph: ProjectGraph; projectId: string }) {
  // Membership-gated on the server, same endpoint the Preview tab reads. A
  // project with no deployment simply answers "not_configured" and the build
  // clause below disappears.
  const { data: status } = useCloudGet<DeploymentStatus>(`/projects/${projectId}/deployment`);
  const shipped = shippedTaskIds(status ?? null);

  if (graph.requirements.length === 0) {
    return <p className="text-sm text-slate-500">Nothing to roll up yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {graph.requirements.map((r) => {
        const specIds = new Set(
          graph.spec_documents.filter((s) => s.requirement_id === r.id).map((s) => s.id),
        );
        const tasks = graph.tasks.filter((t) => t.spec_id && specIds.has(t.spec_id));
        const doneTasks = tasks.filter((t) => DONE.includes(t.status));
        const pct = tasks.length === 0 ? 0 : Math.round((doneTasks.length / tasks.length) * 100);
        const live = doneTasks.filter((t) => shipped.has(t.id)).length;
        return (
          <div key={r.id} className="rounded border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{r.title}</span>
              <span className="text-slate-500">
                {doneTasks.length}/{tasks.length} tasks · {pct}%
              </span>
            </div>
            <div className="mt-2 h-2 rounded bg-slate-100">
              <div className="h-2 rounded bg-slate-900" style={{ width: `${pct}%` }} />
            </div>
            {shipped.size > 0 && (
              <p className="mt-1 text-xs text-slate-500">{live} in the version you can open</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
