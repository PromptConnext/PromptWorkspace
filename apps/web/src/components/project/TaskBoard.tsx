"use client";

import { useEffect, useState } from "react";
import { assignTask, listMembers } from "@/lib/api";
import { authorityOf } from "@/lib/fieldAuthority";
import { useAuth } from "@/lib/auth";
import type { ProjectGraph, Task, TaskStatus, WorkspaceMember } from "@/lib/types";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "implemented", "verified"];

const AUTHORITY_STYLE: Record<string, string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-700",
  shared: "bg-slate-100 text-slate-600",
};

function AssigneeControl({
  task,
  members,
  myUserId,
  myRole,
  projectId,
  onChange,
}: {
  task: Task;
  members: WorkspaceMember[];
  myUserId: string;
  myRole: string | undefined;
  projectId: string;
  onChange: () => void;
}) {
  const { authHeaders } = useAuth();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UX-only gate — the server re-checks role and membership on every write.
  const canEdit =
    myRole === "admin" || task.assigned_user_id === myUserId || task.assigned_user_id == null;

  if (!canEdit) {
    const label = members.find((m) => m.user_id === task.assigned_user_id)?.email ?? task.assigned_user_id;
    return (
      <span className={`rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", "assigned_user_id")]}`}>
        @{label} · pz
      </span>
    );
  }

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value || null;
    setSaving(true);
    setError(null);
    try {
      await assignTask(projectId, task.id, value, authHeaders());
      onChange();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-0.5">
      <select
        value={task.assigned_user_id ?? ""}
        onChange={handleChange}
        disabled={saving}
        className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] disabled:opacity-50"
      >
        <option value="">Unassigned</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>
            {m.email ?? m.user_id}
          </option>
        ))}
      </select>
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </div>
  );
}

function TaskCard({
  task,
  members,
  myUserId,
  myRole,
  projectId,
  onChange,
}: {
  task: Task;
  members: WorkspaceMember[];
  myUserId: string;
  myRole: string | undefined;
  projectId: string;
  onChange: () => void;
}) {
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
      <div className="mt-2 flex flex-wrap items-center gap-1">
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
        <AssigneeControl
          task={task}
          members={members}
          myUserId={myUserId}
          myRole={myRole}
          projectId={projectId}
          onChange={onChange}
        />
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

export function TaskBoard({
  graph,
  workspaceId,
  projectId,
  onChange,
}: {
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
  onChange: () => void;
}) {
  const { user, authHeaders } = useAuth();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);

  useEffect(() => {
    let cancelled = false;
    listMembers(workspaceId, authHeaders())
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
    // authHeaders() is stable per user/token (useCallback in AuthProvider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user]);

  const myRole = members.find((m) => m.user_id === user?.id)?.role;

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
                <TaskCard
                  key={t.id}
                  task={t}
                  members={members}
                  myUserId={user?.id ?? ""}
                  myRole={myRole}
                  projectId={projectId}
                  onChange={onChange}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
