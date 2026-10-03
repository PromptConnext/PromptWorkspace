"use client";

import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { assignTask, listMembers, setTaskStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { taskRefLabel } from "@/lib/taskOrder";
import { useToast } from "@/lib/toast";
import type { Artifact, ProjectGraph, Task, TaskStatus, WorkspaceMember } from "@/lib/types";
import { BOARD_ROW, BoardColumn, BoardSkeleton } from "./BoardColumn";
import { memberShortName } from "./MemberChip";
import {
  buildAnnouncements,
  COLUMNS,
  explain,
  moveDeniedFor,
  SCREEN_READER_INSTRUCTIONS,
  STATUS_LABEL,
} from "./taskBoardA11y";
import { CardBody, TaskCard } from "./TaskCard";
import { canMoveTo } from "./taskPermissions";
import { useOptimisticTasks } from "./useOptimisticTasks";

/**
 * Members decide every permission on the board (`viewer.role` comes from the
 * list), so "the list failed" can't be quietly treated as "nobody's here":
 * that used to strip an admin of drag and verify without a word. Until the
 * list resolves the board is a skeleton; if it fails, the board stays
 * readable but every control is withheld behind an explained Retry.
 */
type MembersState =
  | { status: "loading" }
  | { status: "ready"; members: WorkspaceMember[] }
  | { status: "error"; retrying: boolean };

const NO_MEMBERS: WorkspaceMember[] = [];

// Long enough to notice the toast and reach Undo; a confirmation, not a read.
const UNDO_DURATION = 5000;

export function TaskBoard({
  graph,
  workspaceId,
  projectId,
  onOpenPlanner,
}: {
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
  /** Accepted for call-site compatibility; the board reconciles locally. */
  onChange?: () => void;
  /** Shown as "Go to Planner" on the empty board. */
  onOpenPlanner?: () => void;
}) {
  const { user, authHeaders } = useAuth();
  const { toast } = useToast();
  const [membersState, setMembersState] = useState<MembersState>({ status: "loading" });
  const [membersAttempt, setMembersAttempt] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const board = useOptimisticTasks(graph.tasks);
  // Undo and the drag announcer run after later renders; they read the
  // current rows rather than the ones captured when they were created.
  const tasksRef = useRef(board.tasks);
  tasksRef.current = board.tasks;

  useEffect(() => {
    let cancelled = false;
    listMembers(workspaceId, authHeaders())
      .then((m) => {
        if (!cancelled) setMembersState({ status: "ready", members: m });
      })
      .catch(() => {
        if (!cancelled) setMembersState({ status: "error", retrying: false });
      });
    return () => {
      cancelled = true;
    };
    // authHeaders() is stable per user/token (useCallback in AuthProvider).
    // Keyed on the id, not the user object: a re-render that hands back an
    // equal user must not refetch and silently overwrite a failure the
    // viewer is looking at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user?.id, membersAttempt]);

  const members = membersState.status === "ready" ? membersState.members : NO_MEMBERS;
  const readOnly = membersState.status !== "ready";

  const viewer = useMemo(
    () => ({
      userId: user?.id ?? "",
      role: members.find((m) => m.user_id === user?.id)?.role,
    }),
    [user, members],
  );

  const artifactsByTask = useMemo(() => {
    const byTask = new Map<string, Artifact[]>();
    for (const a of graph.artifacts) {
      if (a.deleted_at) continue;
      const list = byTask.get(a.task_id);
      if (list) list.push(a);
      else byTask.set(a.task_id, [a]);
    }
    return byTask;
  }, [graph.artifacts]);

  const announcements = useMemo(
    () => buildAnnouncements((id) => tasksRef.current.find((t) => t.id === id), viewer),
    [viewer],
  );

  const sensors = useSensors(
    // Mouse and touch rather than one PointerSensor: a pointer sensor claims a
    // finger the moment it lands, which turns scrolling the board on a phone
    // into dragging cards. Touch waits for a deliberate press instead. The
    // mouse keeps a distance threshold so a click on the card's own controls
    // never starts a drag.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function latest(task: Task): Task {
    return tasksRef.current.find((t) => t.id === task.id) ?? task;
  }

  function memberName(userId: string): string {
    return memberShortName(members.find((m) => m.user_id === userId));
  }

  // `board.mutate` reports failure through onError but resolves either way, so
  // success is read off the request itself. An undo is a write like any other
  // but doesn't offer to undo itself.
  async function assign(task: Task, next: string | null, isUndo = false) {
    const label = taskRefLabel(task) ?? task.title;
    const previous = task.assigned_user_id;
    const outcome = { saved: false };
    await board.mutate(task, {
      patch: { assigned_user_id: next },
      request: async () => {
        const row = await assignTask(projectId, task.id, next, authHeaders());
        outcome.saved = true;
        return row;
      },
      onError: (err) =>
        toast({
          variant: "error",
          title: `Couldn't assign ${label}`,
          description: explain(err),
          action: { label: "Retry", onClick: () => void assign(task, next) },
        }),
    });
    if (!outcome.saved || isUndo) return;
    toast({
      variant: "success",
      title: next ? `Assigned ${label} to ${memberName(next)}` : `Unassigned ${label}`,
      duration: UNDO_DURATION,
      action: { label: "Undo", onClick: () => void assign(latest(task), previous, true) },
    });
  }

  async function move(task: Task, next: TaskStatus, isUndo = false) {
    if (next === task.status) return;
    const label = taskRefLabel(task) ?? task.title;
    const previous = task.status;
    const outcome = { saved: false };
    await board.mutate(task, {
      patch: { status: next },
      request: async () => {
        const row = await setTaskStatus(projectId, task.id, next, authHeaders());
        outcome.saved = true;
        return row;
      },
      onError: (err) =>
        toast({
          variant: "error",
          title: `Couldn't move ${label} to ${STATUS_LABEL[next]}`,
          description: explain(err),
          action: { label: "Retry", onClick: () => void move(task, next) },
        }),
    });
    if (!outcome.saved || isUndo) return;
    toast({
      variant: "success",
      title: `Moved ${label} to ${STATUS_LABEL[next]}`,
      duration: UNDO_DURATION,
      action: { label: "Undo", onClick: () => void move(latest(task), previous, true) },
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
        description: moveDeniedFor(task, viewer, next),
      });
      return;
    }
    void move(task, next);
  }

  if (graph.tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-slate-900">No tasks yet</p>
        <p className="mt-1 text-sm text-slate-600">
          Generate them from the Planner&apos;s Tasks stage.
        </p>
        {onOpenPlanner && (
          <button
            type="button"
            onClick={onOpenPlanner}
            className="mt-4 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Go to Planner
          </button>
        )}
      </div>
    );
  }

  if (membersState.status === "loading") return <BoardSkeleton />;

  // Where the board's filter (search, assignee, …) plugs in: everything below
  // renders from this list, so narrowing it narrows every column.
  const visibleTasks = board.tasks;

  return (
    <>
      {membersState.status === "error" && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p className="min-w-0 flex-1">
            Couldn&apos;t load workspace members, so assigning and moving tasks is paused. The
            board is read-only until they load.
          </p>
          <button
            type="button"
            onClick={() => {
              setMembersState({ status: "error", retrying: true });
              setMembersAttempt((n) => n + 1);
            }}
            disabled={membersState.retrying}
            className="rounded-lg border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {membersState.retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      <DndContext
        sensors={sensors}
        // Columns are tall and a card is smaller than the one it is leaving;
        // requiring rect *intersection* makes the last few pixels before a
        // neighbouring column a dead zone. Nearest corner always names a column.
        collisionDetection={closestCorners}
        accessibility={{ announcements, screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className={`${BOARD_ROW} ${activeTask ? "select-none" : ""}`}>
          {COLUMNS.map((column) => {
            const tasks = visibleTasks.filter((t) => t.status === column.status);
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
                    saving={board.savingIds.has(t.id)}
                    readOnly={readOnly}
                    artifacts={artifactsByTask.get(t.id)}
                    onAssign={(task, next) => void assign(task, next)}
                    onMove={(task, next) => void move(task, next)}
                  />
                ))}
              </BoardColumn>
            );
          })}
        </div>
        {/* dnd-kit sizes the overlay to the card being dragged; the clone just
            fills it, so it doesn't change width as it leaves the column. */}
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="relative w-full rotate-1 rounded-lg border border-slate-300 bg-white p-3 shadow-xl">
              <CardBody task={activeTask} dragging />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}
