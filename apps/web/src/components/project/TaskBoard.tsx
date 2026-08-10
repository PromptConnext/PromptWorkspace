"use client";

import { useEffect, useState } from "react";
import { assignTask, listMembers } from "@/lib/api";
import { authorityOf } from "@/lib/fieldAuthority";
import { useAuth } from "@/lib/auth";
import type { ProjectGraph, Task, TaskStatus, WorkspaceMember } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

const COLUMNS: TaskStatus[] = ["todo", "in_progress", "implemented", "verified"];

/**
 * Unassigning is a choice the user makes, not the absence of one, so it has to
 * be a real item in the list. Radix refuses `value=""` on an item (it reserves
 * the empty string for "nothing selected"), hence a sentinel that
 * `handleChange` maps back to the null the assign endpoint expects.
 */
const UNASSIGNED = "__unassigned__";

const AUTHORITY_STYLE: Record<string, string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-700",
  shared: "bg-slate-100 text-slate-600",
};

/**
 * Field ownership (ADR 0010) is worth surfacing — it explains why a value
 * can't be edited here — but "· pmo" is internal vocabulary. Carry the
 * meaning in colour plus a hover title instead of printing the domain name
 * at a business stakeholder.
 */
const AUTHORITY_HINT: Record<string, string> = {
  pz: "Managed in PromptConnext",
  pmo: "Managed by the connected project tracker (Jira / ClickUp)",
  shared: "Editable in PromptConnext and the connected tracker",
};

function authorityHint(field: string): string {
  return AUTHORITY_HINT[authorityOf("tasks", field)];
}

function authorityClass(field: string): string {
  return `rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", field)]}`;
}

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
      <span className={authorityClass("assigned_user_id")} title={authorityHint("assigned_user_id")}>
        @{label}
      </span>
    );
  }

  async function handleChange(next: string) {
    const value = next === UNASSIGNED ? null : next;
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
      <Select
        value={task.assigned_user_id ?? UNASSIGNED}
        onValueChange={handleChange}
        disabled={saving}
      >
        <SelectTrigger aria-label="Assignee" size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
          {members.map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.email ?? m.user_id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
      <p className="font-medium">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {task.feature_tag && (
          <span className={authorityClass("feature_tag")} title={authorityHint("feature_tag")}>
            {task.feature_tag}
          </span>
        )}
        {task.assignee && (
          <span className={authorityClass("assignee")} title={authorityHint("assignee")}>
            @{task.assignee}
          </span>
        )}
        {task.sprint && (
          <span className={authorityClass("sprint")} title={authorityHint("sprint")}>
            {task.sprint}
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
