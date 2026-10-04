"use client";

import { useCloudGet } from "@/lib/hooks";
import type { DeliveryChange, DeliveryPlan as Plan, ProjectGraph } from "@/lib/types";
import { ApprovalControl } from "./ApprovalControl";

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

/** Plan 0029's Delivery Plan: Changes in dependency waves. Changes in one
 * wave can run in parallel; each wave waits for the one before it. */
export function DeliveryPlan({ graph, projectId }: { graph: ProjectGraph; projectId: string }) {
  const { data: plan, error } = useCloudGet<Plan>(`/projects/${projectId}/delivery-plan`);
  const taskById = new Map(graph.tasks.map((t) => [t.id, t]));

  if (error) return <p className="text-sm text-rose-700">{error}</p>;
  if (!plan) return null;
  if (plan.changes.length === 0) {
    // Tasks saved before Changes existed (plan 0029) have none to show until
    // the tasks document is applied again.
    return (
      <p className="text-sm text-slate-500">
        {graph.tasks.length > 0
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
                {change.depends_on.length > 0 && (
                  <p className="mt-1 text-xs text-slate-500">After {change.depends_on.join(", ")}</p>
                )}
                <ul className="mt-2 flex flex-col gap-1">
                  {change.task_ids.map((id) => {
                    const task = taskById.get(id);
                    if (!task) return null;
                    return (
                      <li key={id} className="flex gap-2 text-xs text-slate-600">
                        <span className="font-mono">{(task.feature_tag ?? "").split(" ")[0]}</span>
                        <span className="truncate">{task.title}</span>
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
