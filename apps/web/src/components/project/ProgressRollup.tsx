"use client";

import { useCloudGet } from "@/lib/hooks";
import type { DeploymentOut, DeploymentStatus, ProjectGraph, TaskStatus } from "@/lib/types";

const DONE: TaskStatus[] = ["implemented", "verified"];

/**
 * The builds whose contents are in the version currently being served.
 *
 * Only `live` rows count. A failed build's task set is real history and is
 * shown as such in the Preview tab, but "the version you can open" must mean
 * exactly that — counting a build nobody can reach would be the drift this
 * whole feature exists to avoid.
 *
 * And a frozen set is a *delta*: the commits since the previous successful
 * build. So the cumulative answer is the union of the live builds up to and
 * including the one currently answering at `status.url`, and no further. That
 * bound is the point. Unioning every live row regardless — which this did —
 * over-counts as soon as a rollback happens: the newer build that rolled back
 * past an earlier one's work is still in `recent`, and its tasks would be
 * counted as live even though the version being served no longer contains
 * them.
 *
 * `recent` is newest-first, so the serving build is the *start* of the slice
 * and everything older follows it. When no row's URL matches — a preview URL
 * that changed shape, a status read mid-deploy — the newest live build is the
 * honest fallback: it is the most recent thing known to have published.
 */
export function shippedBuilds(status: DeploymentStatus | null): DeploymentOut[] {
  const live = (status?.recent ?? []).filter((deploy) => deploy.state === "live");
  if (live.length === 0) return [];
  const serving = status?.url ? live.findIndex((deploy) => deploy.url === status.url) : -1;
  return live.slice(serving >= 0 ? serving : 0);
}

/** Task ids in the version you can open, bounded as `shippedBuilds` describes. */
export function shippedTaskIds(status: DeploymentStatus | null): Set<string> {
  const ids = new Set<string>();
  for (const deploy of shippedBuilds(status)) {
    for (const task of deploy.tasks) ids.add(task.id);
  }
  return ids;
}

/**
 * Whether every build contributing to that answer actually has one.
 *
 * One `uncomputed` build in the slice makes the whole count a guess, because
 * its tasks are missing from the union and nothing says so. The count is
 * suppressed rather than rendered low — a number that is quietly wrong is
 * worse than no number, and this is the line ADR 0023 decision 5 promised the
 * platform could stand behind.
 */
export function attributionIsComplete(status: DeploymentStatus | null): boolean {
  return shippedBuilds(status).every((deploy) => deploy.attribution_state === "frozen");
}

export function ProgressRollup({ graph, projectId }: { graph: ProjectGraph; projectId: string }) {
  // Membership-gated on the server, same endpoint the Preview tab reads. A
  // project with no deployment simply answers "not_configured" and the build
  // clause below disappears.
  const { data: status } = useCloudGet<DeploymentStatus>(`/projects/${projectId}/deployment`);
  const builds = shippedBuilds(status ?? null);
  const shipped = shippedTaskIds(status ?? null);
  const complete = attributionIsComplete(status ?? null);

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
            {/* Guarded on whether anything published, not on whether the
                count is above zero. "0 in the version you can open" is a real
                answer about a requirement whose work has not shipped yet, and
                hiding it was how a frozen zero and an unattributed build came
                to look the same. */}
            {builds.length > 0 &&
              (complete ? (
                <p className="mt-1 text-xs text-slate-500">{live} in the version you can open</p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Not yet recorded which of these are in the version you can open
                </p>
              ))}
          </div>
        );
      })}
    </div>
  );
}
