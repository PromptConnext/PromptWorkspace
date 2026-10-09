"use client";

import type { DeliveryChange, ProjectGraph } from "@/lib/types";
import { ApprovalControl } from "./ApprovalControl";
import { ProgressBar } from "./ProgressBar";
import { useDeliveryPlanData } from "./DeliveryOverview";
import { RetryButton } from "./RetryButton";

const KIND_LABEL: Record<DeliveryChange["kind"], string> = {
  setup: "Setup",
  foundational: "Foundational",
  story: "User story",
  other: "Phase",
  polish: "Polish",
  unphased: "Unphased",
};

export function groupByWave(changes: DeliveryChange[]): DeliveryChange[][] {
  const waves: DeliveryChange[][] = [];
  for (const change of [...changes].sort((a, b) => a.wave - b.wave || a.position - b.position)) {
    (waves[change.wave] ??= []).push(change);
  }
  return waves.filter(Boolean);
}

/** The number in a task's leading `T<digits>` ref; null when it has none. */
function taskNumber(featureTag: string | null | undefined): number | null {
  const match = /^T(\d+)/.exec(featureTag ?? "");
  return match ? Number(match[1]) : null;
}

/** Tasks in ref order, those without a ref last. The sort is stable, so ties
 * keep the graph's order. */
function byTaskNumber<T extends { feature_tag?: string | null }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    const x = taskNumber(a.feature_tag);
    const y = taskNumber(b.feature_tag);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return x - y;
  });
}

/** Plan 0029's Delivery Plan: Changes in dependency waves. Changes in one
 * wave can run in parallel; each wave waits for the one before it. The plan
 * does not wait for the project `graph`: it shows as soon as it loads, and the
 * graph fills in each Change's task titles when it arrives. */
export function DeliveryPlan({
  graph,
  graphError = null,
  projectId,
}: {
  graph: ProjectGraph | null;
  /** The page's graph load failed: the graph is not coming, so stop waiting
   *  for it (the page shows the error itself). */
  graphError?: string | null;
  projectId: string;
}) {
  const { data: plan, error, retry } = useDeliveryPlanData();
  const taskById = new Map((graph?.tasks ?? []).map((t) => [t.id, t]));

  if (error) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-rose-700">
        <span>{error}</span>
        <RetryButton onClick={retry} />
      </div>
    );
  }
  // An empty plan reads differently with and without tasks, so it waits for
  // the graph too, unless the graph failed to load.
  if (!plan || (plan.changes.length === 0 && !graph && !graphError)) {
    return <p className="text-sm text-slate-500">Loading delivery plan…</p>;
  }
  if (plan.changes.length === 0) {
    // Tasks saved before Changes existed (plan 0029) have none to show until
    // the tasks document is applied again.
    return (
      <p className="text-sm text-slate-500">
        {graph && graph.tasks.length > 0
          ? "Save the tasks document again in the Planner to group these tasks into Changes."
          : "No delivery plan yet. Generate tasks in the Planner; each phase becomes a Change."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Delivery plan</h3>
          <p className="text-xs text-slate-500">
            {plan.changes.length} changes. Each change is planned to become one pull request.
          </p>
        </div>
        <ApprovalControl projectId={projectId} kind="plan_approval" />
      </div>
      <div className="grid gap-4 md:grid-flow-col md:auto-cols-fr">
        {groupByWave(plan.changes).map((wave, index) => (
          <section key={index} aria-label={`Wave ${index + 1}`} className="flex flex-col gap-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Wave {index + 1}
              {wave.length > 1 ? " · in parallel" : ""}
            </h4>
            {wave.map((change) => (
              <article key={change.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-slate-900">{change.ref}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                    {KIND_LABEL[change.kind]}
                  </span>
                  {change.priority && (
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 text-white">{change.priority}</span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium text-slate-900">{change.title}</p>
                {change.total > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 text-xs text-slate-500">
                      {change.done}/{change.total} done
                    </p>
                    <ProgressBar
                      done={change.done}
                      total={change.total}
                      label={`${change.ref} ${change.title} tasks done`}
                    />
                  </div>
                )}
                {change.depends_on.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">After {change.depends_on.join(", ")}</p>
                )}
                {!graph && !graphError && change.task_ids.length > 0 && (
                  <p className="mt-2 text-xs text-slate-400">
                    {change.task_ids.length} {change.task_ids.length === 1 ? "task" : "tasks"} ·
                    loading titles…
                  </p>
                )}
                <ul className="mt-2 flex flex-col gap-1">
                  {byTaskNumber(
                    change.task_ids.flatMap((id) => {
                      const task = taskById.get(id);
                      return task ? [task] : [];
                    }),
                  ).map((task) => (
                    <li key={task.id} className="flex gap-2 text-xs text-slate-600">
                      <span className="font-mono">{(task.feature_tag ?? "").split(" ")[0]}</span>
                      <span className="truncate">{task.title}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
