"use client";

import { useCloudGet } from "@/lib/hooks";
import type {
  DeploymentOut,
  DeploymentStatus,
  ProjectGraph,
  Task,
  TaskStatus,
} from "@/lib/types";
import { useDeliveryPlanData } from "./DeliveryOverview";
import { ProgressBar } from "./ProgressBar";
import { RetryButton } from "./RetryButton";

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

/** One roll-up row: a title, "done/total tasks · pct%", a bar, and (when a
 * build has published) how many of the done tasks are in the version you can
 * open. */
function RollupRow({
  title,
  tasks,
  shipped,
  builds,
  complete,
}: {
  title: string;
  tasks: Task[];
  shipped: Set<string>;
  builds: DeploymentOut[];
  complete: boolean;
}) {
  const doneTasks = tasks.filter((t) => DONE.includes(t.status));
  const pct = tasks.length === 0 ? 0 : Math.round((doneTasks.length / tasks.length) * 100);
  const live = doneTasks.filter((t) => shipped.has(t.id)).length;
  return (
    <div role="group" aria-label={title} className="rounded border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-slate-500">
          {doneTasks.length}/{tasks.length} tasks · {pct}%
        </span>
      </div>
      <div className="mt-2">
        <ProgressBar done={doneTasks.length} total={tasks.length} label={`${title} tasks done`} />
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
}

export function ProgressRollup({ graph, projectId }: { graph: ProjectGraph; projectId: string }) {
  // Membership-gated on the server, same endpoint the Preview tab reads. A
  // project with no deployment simply answers "not_configured" and the build
  // clause below disappears.
  const { data: status } = useCloudGet<DeploymentStatus>(`/projects/${projectId}/deployment`);
  const { data: plan, error: planError, retry: retryPlan } = useDeliveryPlanData();
  const builds = shippedBuilds(status ?? null);
  const shipped = shippedTaskIds(status ?? null);
  const complete = attributionIsComplete(status ?? null);
  const shared = { shipped, builds, complete };

  // Plan 0029's unit of delivery is the Change, so a project that has Changes
  // is rolled up by them; tasks that sit in none keep a group of their own.
  // When there are no Changes the roll-up is per requirement, as it was. The
  // counts here come from the graph (always at least as fresh as the plan); the
  // plan's own `done`/`total` are the same numbers computed by the server.
  if (!plan && !planError) {
    // Hold the roll-up until the plan settles, so it does not jump from the
    // per-requirement view to the per-Change one.
    return <p className="text-sm text-slate-500">Loading progress…</p>;
  }
  if (plan && plan.changes.length > 0) {
    const ordered = [...plan.changes].sort((a, b) => a.position - b.position);
    const known = new Set(ordered.map((c) => c.id));
    const loose = graph.tasks.filter((t) => !t.change_id || !known.has(t.change_id));
    return (
      <div className="flex flex-col gap-3">
        {ordered.map((c) => {
          const tasks = graph.tasks.filter((t) => t.change_id === c.id);
          // A Change with no tasks has nothing to measure.
          return tasks.length === 0 ? null : (
            <RollupRow key={c.id} title={`${c.ref} ${c.title}`} tasks={tasks} {...shared} />
          );
        })}
        {loose.length > 0 && <RollupRow title="Not in a change" tasks={loose} {...shared} />}
      </div>
    );
  }

  if (graph.requirements.length === 0 && !planError) {
    return <p className="text-sm text-slate-500">Nothing to roll up yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {planError && (
        <div role="alert" className="flex items-center gap-3 text-sm text-rose-700">
          <span>{planError}</span>
          <RetryButton onClick={retryPlan} />
        </div>
      )}
      {graph.requirements.map((r) => {
        const specIds = new Set(
          graph.spec_documents.filter((s) => s.requirement_id === r.id).map((s) => s.id),
        );
        const tasks = graph.tasks.filter((t) => t.spec_id && specIds.has(t.spec_id));
        return <RollupRow key={r.id} title={r.title} tasks={tasks} {...shared} />;
      })}
    </div>
  );
}
