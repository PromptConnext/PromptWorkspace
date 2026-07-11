"use client";

import type { ProjectGraph, TaskStatus } from "@/lib/types";

const DONE: TaskStatus[] = ["implemented", "verified"];

export function ProgressRollup({ graph }: { graph: ProjectGraph }) {
  if (graph.requirements.length === 0) {
    return <p className="text-sm text-slate-500">Nothing to roll up yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {graph.requirements.map((r) => {
        const specIds = new Set(graph.spec_documents.filter((s) => s.requirement_id === r.id).map((s) => s.id));
        const tasks = graph.tasks.filter((t) => t.spec_id && specIds.has(t.spec_id));
        const done = tasks.filter((t) => DONE.includes(t.status)).length;
        const pct = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);
        return (
          <div key={r.id} className="rounded border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{r.title}</span>
              <span className="text-slate-500">
                {done}/{tasks.length} tasks · {pct}%
              </span>
            </div>
            <div className="mt-2 h-2 rounded bg-slate-100">
              <div className="h-2 rounded bg-slate-900" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
