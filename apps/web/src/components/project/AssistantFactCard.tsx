"use client";

// Exact counts from the lineage graph walk (apps/cloud/app/rag/lineage.py) —
// not model output. Rendered as its own card so a reader can tell which part
// of the answer is computed and which part is generated.
//
// Which fields a walk populates depends on its scope, so a zero means "not
// applicable to this scope", not "none". Printing zeros makes a valid
// project-scope card look broken, so they are omitted.

import type { LineageFacts } from "@/lib/types";

export function AssistantFactCard({ facts }: { facts: LineageFacts }) {
  const counts: string[] = [];
  if (facts.specs_total > 0) counts.push(`${facts.specs_total} specs`);
  if (facts.tasks_total > 0) counts.push(`${facts.tasks_total} tasks`);
  if (facts.tasks_done > 0) counts.push(`${facts.tasks_done} done`);
  if (facts.artifacts_total > 0) counts.push(`${facts.artifacts_total} artifacts`);

  const breakdown = Object.entries(facts.task_status_counts).filter(([, n]) => n > 0);
  const failedRuns = facts.agent_runs.filter((r) => r.status === "failed").length;

  return (
    <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">from the task graph</p>
      <p className="mt-1 font-medium text-slate-900">{facts.title}</p>
      {facts.status && <p className="text-xs text-slate-600">status · {facts.status}</p>}

      {counts.length > 0 && <p className="mt-2 text-slate-700">{counts.join(" · ")}</p>}

      {breakdown.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          {breakdown.map(([status, n]) => `${status} ${n}`).join(" · ")}
        </p>
      )}

      {facts.agent_runs.length > 0 && (
        <p className="mt-1 text-xs text-slate-600">
          {facts.agent_runs.length} agent runs
          {failedRuns > 0 && ` · ${failedRuns} failed`}
        </p>
      )}
    </div>
  );
}
