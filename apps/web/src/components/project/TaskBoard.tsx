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
import { applyBoardFilters, groupBoardTasks, specLabel } from "@/lib/boardFilters";
import { taskRefLabel } from "@/lib/taskOrder";
import { useToast } from "@/lib/toast";
import type { Artifact, ProjectGraph, Task, TaskStatus, WorkspaceMember } from "@/lib/types";
import { BOARD_ROW, BoardColumn, BoardSkeleton } from "./BoardColumn";
import { BoardToolbar } from "./BoardToolbar";
import { memberShortName } from "./MemberChip";
import {
  buildAnnouncements,
  columnOf,
  COLUMN_STATUSES,
  COLUMNS,
  explain,
  laneDropId,
  moveDeniedFor,
  SCREEN_READER_INSTRUCTIONS,
  STATUS_LABEL,
} from "./taskBoardA11y";
import { AssigneeControl, CardBody, LockNote, MoveMenu, TaskCard } from "./TaskCard";
import { TaskDrawer } from "./TaskDrawer";
import { canMoveAnywhere, canMoveTo, moveDeniedReason } from "./taskPermissions";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { useBoardUrlState } from "./useBoardUrlState";
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

const NUMERIC = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function countLabel(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`;
}

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
  // Collapsed swimlanes, keyed `${group}:${laneKey}` so "Unassigned" folded
  // under Assignee doesn't fold "No sprint" when the grouping changes.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const { filters, setFilters, clearFilters, openTaskId, openTask, closeTask } = useBoardUrlState();
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

  const sprints = useMemo(
    () =>
      [...new Set(graph.tasks.map((t) => t.sprint?.trim()).filter((s): s is string => !!s))].sort(
        NUMERIC.compare,
      ),
    [graph.tasks],
  );

  // Only specs some task points at: a filter option that empties the board is
  // a dead end.
  const specs = useMemo(
    () =>
      [...new Set(graph.tasks.map((t) => t.spec_id).filter((id): id is string => id !== null))]
        .map((id) => ({ id, label: specLabel(graph, id) ?? "Unknown spec" }))
        .sort((a, b) => NUMERIC.compare(a.label, b.label)),
    [graph],
  );

  const membersLoading = membersState.status === "loading";

  useBoardShortcuts({
    onSearch: () => searchRef.current?.focus(),
    onToggleMine: () => setFilters({ assignee: filters.assignee === "me" ? null : "me" }),
    // The search box clears itself on Esc and the drawer closes itself; a
    // board-level Esc on top of either would act twice on one key press.
    onEscape: () => {},
    enabled: !membersLoading && graph.tasks.length > 0,
  });

  // A `?task=` link to a task that has since been deleted (or never existed
  // here) quietly drops the param rather than showing an empty drawer. Waits
  // for members, since the board — and with it the drawer — isn't up before.
  const openStale =
    openTaskId !== null && !membersLoading && !board.tasks.some((t) => t.id === openTaskId);
  useEffect(() => {
    if (openStale) closeTask();
  }, [openStale, closeTask]);

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
    // Only the column counts. A swimlane is a view of the assignee, sprint or
    // spec, not a control for it: dropping into another lane changes status
    // alone, never reassigns or re-plans the task.
    const next = columnOf(target);
    if (!next || next === task.status) return;
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

  // Everything below renders from this list, so narrowing it narrows every
  // column and every lane.
  const visibleTasks = applyBoardFilters(board.tasks, filters, viewer.userId);
  // The optimistic row, so the drawer shows a pending move or assignment.
  const openedTask = openTaskId ? (board.tasks.find((t) => t.id === openTaskId) ?? null) : null;

  function toggleLane(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function columnsFor(tasks: Task[], laneKey: string | null) {
    return (
      <div className={`${BOARD_ROW} ${activeTask ? "select-none" : ""}`}>
        {COLUMNS.map((column) => {
          const inColumn = tasks.filter((t) => t.status === column.status);
          return (
            <BoardColumn
              key={column.status}
              column={column}
              tasks={inColumn}
              activeTask={activeTask}
              viewer={viewer}
              dropId={laneKey === null ? column.status : laneDropId(laneKey, column.status)}
            >
              {inColumn.map((t) => (
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
                  onOpen={(task) => openTask(task.id)}
                />
              ))}
            </BoardColumn>
          );
        })}
      </div>
    );
  }

  const lanes =
    filters.group === "none"
      ? null
      : groupBoardTasks(visibleTasks, filters.group, {
          memberLabel: (id) => memberName(id ?? ""),
          specLabel: (id) => (id ? (specLabel(graph, id) ?? "Unknown spec") : "No spec"),
        });

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
      <div className="mb-4">
        <BoardToolbar
          filters={filters}
          onChange={setFilters}
          onClear={clearFilters}
          members={members}
          sprints={sprints}
          specs={specs}
          viewerId={viewer.userId}
          resultCount={visibleTasks.length}
          totalCount={board.tasks.length}
          searchInputRef={searchRef}
        />
      </div>
      {visibleTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">No tasks match these filters</p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-4 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Clear Filters
          </button>
        </div>
      ) : (
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
          {lanes === null ? (
            columnsFor(visibleTasks, null)
          ) : (
            <div className="flex flex-col gap-5">
              {lanes.map((lane) => {
                const foldKey = `${filters.group}:${lane.key}`;
                const open = !collapsed.has(foldKey);
                return (
                  <section
                    key={lane.key}
                    aria-label={`${lane.label}, ${countLabel(lane.tasks.length)}`}
                  >
                    <h3 className="mb-2">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleLane(foldKey)}
                        className="flex items-center gap-2 rounded px-1 text-sm font-semibold text-slate-800 transition-colors hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                      >
                        <ChevronIcon open={open} />
                        <span>{lane.label}</span>
                        <span className="rounded-full bg-slate-200 px-1.5 text-[11px] font-medium tabular-nums text-slate-700">
                          {lane.tasks.length}
                        </span>
                      </button>
                    </h3>
                    {open && columnsFor(lane.tasks, lane.key)}
                  </section>
                );
              })}
            </div>
          )}
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
      )}
      <TaskDrawer
        task={openedTask}
        graph={graph}
        members={members}
        onClose={closeTask}
        // The card's own controls and write path, so a change made here gets
        // the same permission rules, optimistic update and Undo toast.
        renderAssignee={(t) => (
          <AssigneeControl
            task={t}
            members={members}
            owner={members.find((m) => m.user_id === t.assigned_user_id)}
            viewer={viewer}
            readOnly={readOnly}
            onAssign={(task, next) => void assign(task, next)}
          />
        )}
        renderMove={
          readOnly
            ? undefined
            : (t) => (
                <span className="flex items-center gap-2">
                  <span className="text-slate-700">{STATUS_LABEL[t.status]}</span>
                  {canMoveAnywhere(t, viewer, COLUMN_STATUSES) ? (
                    <MoveMenu
                      task={t}
                      viewer={viewer}
                      onMove={(task, next) => void move(task, next)}
                    />
                  ) : (
                    <LockNote reason={moveDeniedReason(t, viewer)} />
                  )}
                </span>
              )
        }
      />
    </>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 text-slate-500 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
