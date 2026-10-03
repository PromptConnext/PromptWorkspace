"use client";

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useEffect, useMemo, useState } from "react";
import { assignTask, listMembers, setTaskStatus } from "@/lib/api";
import { authorityOf } from "@/lib/fieldAuthority";
import { useAuth } from "@/lib/auth";
import { taskRefLabel } from "@/lib/taskOrder";
import { useToast } from "@/lib/toast";
import type { ProjectGraph, Task, TaskStatus, WorkspaceMember } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import {
  assignableUserIds,
  canAssign,
  canMoveAnywhere,
  canMoveTo,
  moveDeniedReason,
} from "./taskPermissions";
import { useOptimisticTasks } from "./useOptimisticTasks";
import type { OptimisticTasks } from "./useOptimisticTasks";

interface Column {
  status: TaskStatus;
  label: string;
  accent: string;
}

const COLUMNS: Column[] = [
  { status: "todo", label: "To Do", accent: "bg-slate-400" },
  { status: "in_progress", label: "In Progress", accent: "bg-blue-500" },
  { status: "implemented", label: "Implemented", accent: "bg-violet-500" },
  { status: "verified", label: "Verified", accent: "bg-emerald-500" },
];

const COLUMN_STATUSES = COLUMNS.map((c) => c.status);
const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.status, c.label])) as Record<
  TaskStatus,
  string
>;

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
  pz: "Managed in PromptWorkspace",
  pmo: "Managed by the connected project tracker (Jira / ClickUp)",
  shared: "Editable in PromptWorkspace and the connected tracker",
};

function authorityHint(field: string): string {
  return AUTHORITY_HINT[authorityOf("tasks", field)];
}

function authorityClass(field: string): string {
  return `rounded px-1.5 py-0.5 text-[10px] ${AUTHORITY_STYLE[authorityOf("tasks", field)]}`;
}

function memberLabel(members: WorkspaceMember[], userId: string | null): string {
  if (!userId) return "Unassigned";
  return members.find((m) => m.user_id === userId)?.email ?? userId;
}

/**
 * A card is a few hundred pixels wide and an email address is not. The trigger
 * shows the local part only — `dev-user`, not `dev-user@promptworkspace.local` —
 * with the full address kept in the option list and the hover title, where
 * there is room to disambiguate two people who share a first name.
 */
function shortLabel(full: string): string {
  if (full === "Unassigned") return full;
  const at = full.indexOf("@");
  return at > 0 ? full.slice(0, at) : full;
}

/**
 * What the toast says when a write bounces. The endpoints answer in machine
 * vocabulary (`assignment_forbidden`, `verified_requires_admin`) because their
 * other caller is the VS Code extension; a person reading a toast needs the
 * sentence, and the raw code only as the technical detail underneath.
 */
const FRIENDLY_DETAIL: Record<string, string> = {
  assignment_forbidden: "You can only assign tasks to yourself.",
  assignee_not_a_member: "That person is no longer a member of this workspace.",
  status_forbidden: "You can only move tasks assigned to you.",
  verified_requires_admin: "Only a workspace admin can mark a task verified.",
  task_not_found: "This task no longer exists — refresh the board.",
};

function explain(error: Error): string {
  return FRIENDLY_DETAIL[error.message] ?? error.message;
}

function AssigneeControl({
  task,
  members,
  viewer,
  onAssign,
}: {
  task: Task;
  members: WorkspaceMember[];
  viewer: { userId: string; role: string | undefined };
  onAssign: (task: Task, next: string | null) => void;
}) {
  const editable = canAssign(task, viewer);
  const allowed = useMemo(
    () => new Set(assignableUserIds(viewer, members.map((m) => m.user_id))),
    [viewer, members],
  );

  const current = memberLabel(members, task.assigned_user_id);

  if (!editable) {
    return (
      <span
        className={`${authorityClass("assigned_user_id")} block truncate`}
        title={`${authorityHint("assigned_user_id")} — assigned to ${current}`}
      >
        @{shortLabel(current)}
      </span>
    );
  }

  return (
    <Select
      value={task.assigned_user_id ?? UNASSIGNED}
      onValueChange={(next) => onAssign(task, next === UNASSIGNED ? null : next)}
    >
      <SelectTrigger
        aria-label="Assignee"
        size="sm"
        className="w-full min-w-0 overflow-hidden"
        title={current}
      >
        <SelectValue>
          <span className="block w-full truncate text-left">{shortLabel(current)}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {members
          .filter((m) => allowed.has(m.user_id))
          .map((m) => (
            <SelectItem key={m.user_id} value={m.user_id}>
              {m.email ?? m.user_id}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The keyboard and screen-reader path to the same move dragging performs.
 * dnd-kit does announce a drag, but a picker is the control someone who never
 * reaches for a pointer expects to find, and it costs one Select.
 */
function StatusControl({
  task,
  viewer,
  onMove,
}: {
  task: Task;
  viewer: { userId: string; role: string | undefined };
  onMove: (task: Task, next: TaskStatus) => void;
}) {
  const movable = canMoveAnywhere(task, viewer, COLUMN_STATUSES);
  if (!movable) {
    return (
      <span
        className="block truncate rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500"
        title={moveDeniedReason(task, viewer)}
      >
        {STATUS_LABEL[task.status]}
      </span>
    );
  }
  return (
    <Select value={task.status} onValueChange={(next) => onMove(task, next as TaskStatus)}>
      <SelectTrigger aria-label="Status" size="sm" className="w-full min-w-0 overflow-hidden">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {COLUMNS.map((c) => (
          <SelectItem
            key={c.status}
            value={c.status}
            disabled={c.status !== task.status && !canMoveTo(task, viewer, c.status)}
          >
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CardBody({
  task,
  dragging,
  saving,
}: {
  task: Task;
  dragging?: boolean;
  saving?: boolean;
}) {
  const ref = taskRefLabel(task);
  return (
    <>
      {/* A 2px bar, not a spinner: the write is optimistic, so the card is
          already showing the new value and must stay readable and clickable
          while it settles. */}
      <span
        aria-hidden
        className={`absolute inset-x-0 top-0 h-0.5 rounded-t bg-blue-400 transition-opacity ${
          saving ? "animate-pulse opacity-100" : "opacity-0"
        }`}
      />
      <div className="flex items-start gap-2">
        {ref && (
          <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold text-slate-400">
            {ref}
          </span>
        )}
        <p className="flex-1 text-sm font-medium leading-snug text-slate-900">{task.title}</p>
      </div>
      {!dragging && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
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
        </div>
      )}
    </>
  );
}

function TaskCard({
  task,
  members,
  viewer,
  board,
  onAssign,
  onMove,
}: {
  task: Task;
  members: WorkspaceMember[];
  viewer: { userId: string; role: string | undefined };
  board: OptimisticTasks;
  onAssign: (task: Task, next: string | null) => void;
  onMove: (task: Task, next: TaskStatus) => void;
}) {
  const draggable = canMoveAnywhere(task, viewer, COLUMN_STATUSES);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  const saving = board.savingIds.has(task.id);

  return (
    <div
      ref={setNodeRef}
      className={[
        "relative rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-shadow",
        // The card stays in place, greyed, while its clone follows the pointer —
        // a column that reflows mid-drag makes the drop target guesswork.
        isDragging ? "opacity-40" : "hover:shadow-md",
      ].join(" ")}
    >
      <div
        // Only spread dnd-kit's attributes when the card can actually move —
        // they carry role="button" and tabIndex, and a focusable button that
        // refuses every key is worse than plain text.
        {...(draggable ? { ...listeners, ...attributes } : {})}
        title={draggable ? undefined : moveDeniedReason(task, viewer)}
        className={draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default"}
      >
        <CardBody task={task} saving={saving} />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        {/* Who owns it is the field people scan and change most, so it takes the
            slack; the status picker only ever holds four short labels. */}
        <div className="min-w-0 flex-1">
          <AssigneeControl task={task} members={members} viewer={viewer} onAssign={onAssign} />
        </div>
        <div className="w-[6.5rem] shrink-0">
          <StatusControl task={task} viewer={viewer} onMove={onMove} />
        </div>
      </div>
      {task.acceptance_criteria.length > 0 && (
        <details className="mt-2 text-xs text-slate-500">
          <summary className="cursor-pointer select-none text-[11px] text-slate-400 hover:text-slate-600">
            {task.acceptance_criteria.length} acceptance{" "}
            {task.acceptance_criteria.length === 1 ? "criterion" : "criteria"}
          </summary>
          <ul className="mt-1 list-inside list-disc">
            {task.acceptance_criteria.map((c, i) => (
              <li key={i}>{c.text}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function BoardColumn({
  column,
  tasks,
  activeTask,
  viewer,
  children,
}: {
  column: Column;
  tasks: Task[];
  activeTask: Task | null;
  viewer: { userId: string; role: string | undefined };
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.status });
  // Highlight only where the card in hand can actually land, so an illegal
  // move is refused before the drop rather than rolled back after it.
  const receptive =
    activeTask !== null &&
    activeTask.status !== column.status &&
    canMoveTo(activeTask, viewer, column.status);

  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={[
        "flex flex-col rounded-lg border p-2 transition-colors",
        isOver && receptive
          ? "border-blue-400 bg-blue-50"
          : receptive
            ? "border-dashed border-slate-300 bg-slate-100/80"
            : "border-transparent bg-slate-100/70",
      ].join(" ")}
    >
      <header className="flex items-center gap-2 px-1 pb-2">
        <span className={`h-1.5 w-1.5 rounded-full ${column.accent}`} aria-hidden />
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {column.label}
        </h3>
        <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-medium text-slate-600">
          {tasks.length}
        </span>
      </header>
      <div className="flex min-h-16 flex-col gap-2">
        {children}
        {tasks.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 px-2 py-4 text-center text-[11px] text-slate-400">
            {receptive ? "Drop here" : "No tasks"}
          </p>
        )}
      </div>
    </section>
  );
}

export function TaskBoard({
  graph,
  workspaceId,
  projectId,
}: {
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
  /** Accepted for call-site compatibility; the board reconciles locally. */
  onChange?: () => void;
}) {
  const { user, authHeaders } = useAuth();
  const { toast } = useToast();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const board = useOptimisticTasks(graph.tasks);

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

  const viewer = useMemo(
    () => ({
      userId: user?.id ?? "",
      role: members.find((m) => m.user_id === user?.id)?.role,
    }),
    [user, members],
  );

  const sensors = useSensors(
    // A card holds two Selects. Without a distance threshold the pointer-down
    // that opens one of them would start a drag instead.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function assign(task: Task, next: string | null) {
    const label = taskRefLabel(task) ?? task.title;
    board.mutate(task, {
      patch: { assigned_user_id: next },
      request: () => assignTask(projectId, task.id, next, authHeaders()),
      onError: (err) =>
        toast({
          variant: "error",
          title: `Couldn't assign ${label}`,
          description: explain(err),
          action: { label: "Retry", onClick: () => assign(task, next) },
        }),
    });
  }

  function move(task: Task, next: TaskStatus) {
    if (next === task.status) return;
    const label = taskRefLabel(task) ?? task.title;
    board.mutate(task, {
      patch: { status: next },
      request: () => setTaskStatus(projectId, task.id, next, authHeaders()),
      onError: (err) =>
        toast({
          variant: "error",
          title: `Couldn't move ${label} to ${STATUS_LABEL[next]}`,
          description: explain(err),
          action: { label: "Retry", onClick: () => move(task, next) },
        }),
    });
  }

  const activeTask = activeId ? (board.tasks.find((t) => t.id === activeId) ?? null) : null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const target = event.over?.id;
    if (!target) return;
    const task = board.tasks.find((t) => t.id === String(event.active.id));
    if (!task) return;
    const next = String(target) as TaskStatus;
    if (next === task.status) return;
    if (!canMoveTo(task, viewer, next)) {
      toast({
        variant: "error",
        title: `Can't move ${taskRefLabel(task) ?? task.title} to ${STATUS_LABEL[next]}`,
        description:
          next === "verified"
            ? FRIENDLY_DETAIL.verified_requires_admin
            : moveDeniedReason(task, viewer),
      });
      return;
    }
    move(task, next);
  }

  return (
    <DndContext
      sensors={sensors}
      // Columns are tall and a card is smaller than the one it is leaving;
      // requiring rect *intersection* makes the last few pixels before a
      // neighbouring column a dead zone. Nearest corner always names a column.
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {COLUMNS.map((column) => {
          const tasks = board.tasks.filter((t) => t.status === column.status);
          return (
            <BoardColumn
              key={column.status}
              column={column}
              tasks={tasks}
              activeTask={activeTask}
              viewer={viewer}
            >
              {tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  members={members}
                  viewer={viewer}
                  board={board}
                  onAssign={assign}
                  onMove={move}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask && (
          <div className="relative w-64 rotate-1 rounded-lg border border-slate-300 bg-white p-3 shadow-xl">
            <CardBody task={activeTask} dragging />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
