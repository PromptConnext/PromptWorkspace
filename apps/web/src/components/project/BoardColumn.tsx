"use client";

import { useDroppable } from "@dnd-kit/core";
import type { Task } from "@/lib/types";
import { COLUMNS } from "./taskBoardA11y";
import type { Column } from "./taskBoardA11y";
import { canMoveTo } from "./taskPermissions";
import type { Viewer } from "./taskPermissions";

/**
 * Columns share the row's width between a floor and a ceiling: on a wide
 * screen they grow to fill it, and below the floor the row scrolls sideways
 * (snapping per column, the next one peeking) rather than squeezing four
 * columns into whatever the page leaves — a card narrower than its assignee
 * name is worse than a scrollbar. Each column scrolls its own cards so the
 * headers — and the other columns' drop zones — stay in view.
 */
export const BOARD_ROW =
  "flex snap-x snap-mandatory items-start gap-3 overflow-x-auto overscroll-x-contain pb-2";
const COLUMN_SHELL = "flex min-w-[17rem] max-w-[26rem] flex-1 snap-start flex-col rounded-lg border";
const COLUMN_LIST = "flex max-h-[calc(100vh-16rem)] min-h-16 flex-col gap-2 overflow-y-auto px-2 pb-2";

function countLabel(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"}`;
}

export function BoardColumn({
  column,
  tasks,
  activeTask,
  viewer,
  lane,
  dropId = column.status,
  children,
}: {
  column: Column;
  tasks: Task[];
  activeTask: Task | null;
  viewer: Viewer;
  /**
   * The swimlane this column sits in. It prefixes the region name, so a
   * screen reader's landmark list reads "dev — To Do" rather than one "To Do"
   * per lane, and drops the heading a level under the lane's own h3.
   */
  lane?: string;
  /** Unique per swimlane (see `laneDropId`); the bare status otherwise. */
  dropId?: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  // Highlight only where the card in hand can actually land, so an illegal
  // move is refused before the drop rather than rolled back after it.
  const foreign = activeTask !== null && activeTask.status !== column.status;
  const receptive = foreign && canMoveTo(activeTask, viewer, column.status);
  const refused = foreign && !receptive;
  const Heading = lane === undefined ? "h3" : "h4";

  return (
    <section
      ref={setNodeRef}
      aria-label={`${lane === undefined ? "" : `${lane} — `}${column.label}, ${countLabel(tasks.length)}`}
      className={[
        COLUMN_SHELL,
        "transition-[background-color,border-color,opacity]",
        isOver && receptive
          ? "border-blue-400 bg-blue-50"
          : receptive
            ? "border-dashed border-slate-300 bg-slate-100/80"
            : "border-transparent bg-slate-100/70",
        refused ? "opacity-50" : "",
      ].join(" ")}
    >
      <header className="flex items-center gap-2 px-3 pb-2 pt-2">
        <span className={`h-1.5 w-1.5 rounded-full ${column.accent}`} aria-hidden />
        <Heading className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          {column.label}
        </Heading>
        <span
          aria-hidden
          className="rounded-full bg-slate-200 px-1.5 text-[11px] font-medium tabular-nums text-slate-700"
        >
          {tasks.length}
        </span>
        {refused && <span className="ml-auto text-[11px] text-slate-600">Not allowed</span>}
      </header>
      <div className={COLUMN_LIST}>
        {children}
        {tasks.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-300 px-2 py-4 text-center text-[11px] text-slate-600">
            {receptive ? "Drop here" : "No tasks"}
          </p>
        )}
      </div>
    </section>
  );
}

/** Column shells with grey cards, shown until members (or the graph) resolve. */
export function BoardSkeleton({ label = "Loading tasks…" }: { label?: string }) {
  return (
    <div aria-busy="true" className={BOARD_ROW}>
      <span className="sr-only" role="status">
        {label}
      </span>
      {COLUMNS.map((column, i) => (
        <div key={column.status} aria-hidden className={`${COLUMN_SHELL} border-transparent bg-slate-100/70`}>
          <div className="flex items-center gap-2 px-3 pb-2 pt-2">
            <span className={`h-1.5 w-1.5 rounded-full ${column.accent}`} />
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              {column.label}
            </span>
          </div>
          <div className="flex flex-col gap-2 px-2 pb-2">
            {Array.from({ length: 3 - (i % 2) }, (_, n) => (
              <div
                key={n}
                className="h-20 animate-pulse rounded-lg border border-slate-200 bg-white motion-reduce:animate-none"
              >
                <div className="m-3 h-3 w-3/4 rounded bg-slate-200" />
                <div className="mx-3 h-3 w-1/2 rounded bg-slate-200" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
