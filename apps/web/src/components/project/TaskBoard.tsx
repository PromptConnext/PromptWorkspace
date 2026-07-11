"use client";

import { authorityOf } from "@/lib/fieldAuthority";
import type { ProjectGraph, Task, TaskStatus } from "@/lib/types";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "implemented", "verified"];

const AUTHORITY_STYLE: Record<string, string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-700",
  shared: "bg-slate-100 text-slate-600",
};

function TaskCard({ task }: { task: Task }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${AUTHORITY_STYLE[authorityOf("tasks", "title")]}`}
        >
          title · shared
        </span>
      </div>
      <p className="mt-1 font-medium">{task.title}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {task.feature_tag && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", "feature_tag")]}`}>
            {task.feature_tag} · pmo
          </span>
        )}
        {task.assignee && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", "assignee")]}`}>
            @{task.assignee} · pmo
          </span>
        )}
        {task.sprint && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", "sprint")]}`}>
            {task.sprint} · pmo
          </span>
        )}
      </div>
      {task.acceptance_criteria.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-xs text-slate-500">
          {task.acceptance_criteria.map((c, i) => (
            <li key={i}>{c.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TaskBoard({ graph }: { graph: ProjectGraph }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {COLUMNS.map((status) => {
        const tasks = graph.tasks.filter((t) => t.status === status);
        return (
          <div key={status} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase text-slate-500">
              {status} <span className="text-slate-400">({tasks.length})</span>
            </h3>
            <div className="flex flex-col gap-2">
              {tasks.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
