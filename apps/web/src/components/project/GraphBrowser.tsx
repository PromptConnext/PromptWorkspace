"use client";

import { useState } from "react";
import type { ProjectGraph, Requirement, SpecDocument, Task } from "@/lib/types";

function TaskNode({ task, graph }: { task: Task; graph: ProjectGraph }) {
  const artifacts = graph.artifacts.filter((a) => a.task_id === task.id);
  const runs = graph.agent_runs.filter((r) => r.task_id === task.id);
  return (
    <li className="ml-4 border-l border-slate-200 pl-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{task.status}</span>
        <span>{task.title}</span>
      </div>
      {(artifacts.length > 0 || runs.length > 0) && (
        <ul className="ml-4 mt-1 flex flex-col gap-1 text-xs text-slate-500">
          {artifacts.map((a) => (
            <li key={a.id}>artifact · {a.kind} · {a.uri}</li>
          ))}
          {runs.map((r) => (
            <li key={r.id}>agent-run · {r.model_role} · {r.status}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SpecNode({ spec, graph }: { spec: SpecDocument; graph: ProjectGraph }) {
  const tasks = graph.tasks.filter((t) => t.spec_id === spec.id);
  return (
    <li className="ml-4 border-l border-slate-200 pl-3">
      <div className="text-sm text-slate-700">
        spec v{spec.version} · {spec.status}
      </div>
      <ul className="mt-1">
        {tasks.map((t) => (
          <TaskNode key={t.id} task={t} graph={graph} />
        ))}
      </ul>
    </li>
  );
}

function RequirementNode({ requirement, graph }: { requirement: Requirement; graph: ProjectGraph }) {
  const [open, setOpen] = useState(true);
  const specs = graph.spec_documents.filter((s) => s.requirement_id === requirement.id);
  return (
    <li>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-100"
      >
        <span className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{requirement.status}</span>
        <span className="font-medium">{requirement.title}</span>
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1">
          {specs.map((s) => (
            <SpecNode key={s.id} spec={s} graph={graph} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function GraphBrowser({ graph }: { graph: ProjectGraph }) {
  if (graph.requirements.length === 0) {
    return <p className="text-sm text-slate-500">No requirements synced for this project yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {graph.requirements.map((r) => (
        <RequirementNode key={r.id} requirement={r} graph={graph} />
      ))}
    </ul>
  );
}
