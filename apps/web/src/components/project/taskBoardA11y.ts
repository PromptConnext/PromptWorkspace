import type { Announcements, ScreenReaderInstructions } from "@dnd-kit/core";
import { plainInlineCode } from "@/lib/inlineCode";
import { taskRefLabel } from "@/lib/taskOrder";
import type { Task, TaskStatus } from "@/lib/types";
import { canMoveTo, moveDeniedReason } from "./taskPermissions";
import type { Viewer } from "./taskPermissions";

/**
 * The words the board says — column labels, failure sentences, and what a
 * screen reader hears during a drag. They live together because they are the
 * same vocabulary: an announcement that says "in_progress" or a task UUID is
 * as useless as a toast that does.
 */

export interface Column {
  status: TaskStatus;
  label: string;
  accent: string;
}

export const COLUMNS: Column[] = [
  { status: "todo", label: "To Do", accent: "bg-slate-400" },
  { status: "in_progress", label: "In Progress", accent: "bg-blue-500" },
  { status: "implemented", label: "Implemented", accent: "bg-violet-500" },
  { status: "verified", label: "Verified", accent: "bg-emerald-500" },
];

export const COLUMN_STATUSES = COLUMNS.map((c) => c.status);

export const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.status, c.label])) as Record<
  TaskStatus,
  string
>;

/** "T004 · Login form" — the reference people use, plus the words they recognise. */
export function taskName(task: Task): string {
  const ref = taskRefLabel(task);
  const title = plainInlineCode(task.title);
  return ref ? `${ref} · ${title}` : title;
}

/**
 * What the toast says when a write bounces. The endpoints answer in machine
 * vocabulary (`assignment_forbidden`, `verified_requires_admin`) because their
 * other caller is the VS Code extension; a person reading a toast needs the
 * sentence, and the raw code only as the technical detail underneath.
 */
export const FRIENDLY_DETAIL: Record<string, string> = {
  assignment_forbidden: "You can only assign tasks to yourself.",
  assignee_not_a_member: "That person is no longer a member of this workspace.",
  status_forbidden: "You can only move tasks assigned to you.",
  verified_requires_admin: "Only a workspace admin can mark a task verified.",
  task_not_found: "This task no longer exists — refresh the board.",
};

const GENERIC_FAILURE =
  "Something went wrong saving this change. Try again, or refresh the board if it keeps happening.";

export function explain(error: Error): string {
  const known = FRIENDLY_DETAIL[error.message];
  if (known) return known;
  // An unknown message may be a stack-trace-sized blob; it is a hint for
  // whoever files the bug, not something to read, so it stays short.
  const code = error.message.trim();
  if (!code) return GENERIC_FAILURE;
  return `${GENERIC_FAILURE} (code: ${code.length > 60 ? `${code.slice(0, 60)}…` : code})`;
}

/** Why `task` can't land in `target`, phrased for the person holding it. */
export function moveDeniedFor(task: Task, viewer: Viewer, target: TaskStatus): string {
  return target === "verified" && task.assigned_user_id === viewer.userId
    ? FRIENDLY_DETAIL.verified_requires_admin
    : moveDeniedReason(task, viewer);
}

export const SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    "To pick up a task, press Space or Enter. Use the arrow keys to move it between columns, " +
    "then press Space or Enter to drop it, or Escape to cancel.",
};

/**
 * Swimlanes repeat the four columns once per group, and dnd-kit needs every
 * droppable id unique, so a lane's column is `${laneKey}::${status}`. The
 * status is always the part after the last separator, which keeps a lane key
 * that itself contains "::" (a sprint name, say) unambiguous. An ungrouped
 * board uses the bare status, which parses the same way.
 */
const LANE_SEPARATOR = "::";

export function laneDropId(laneKey: string, status: TaskStatus): string {
  return `${laneKey}${LANE_SEPARATOR}${status}`;
}

/** The column a droppable id names, or null when it names none. */
export function columnOf(id: string | number | undefined | null): TaskStatus | null {
  if (id === undefined || id === null) return null;
  const raw = String(id);
  const at = raw.lastIndexOf(LANE_SEPARATOR);
  const status = (at === -1 ? raw : raw.slice(at + LANE_SEPARATOR.length)) as TaskStatus;
  return COLUMN_STATUSES.includes(status) ? status : null;
}

/**
 * dnd-kit's defaults read out "Draggable item 6f1c… was dropped over droppable
 * area in_progress". These name the task and the column instead, and say *why*
 * a column refuses the card, which a sighted user gets from the dimming.
 *
 * `find` is called at announcement time so the text reflects the card's
 * current status, not the one it had when the announcer was built.
 */
export function buildAnnouncements(
  find: (id: string) => Task | undefined,
  viewer: Viewer,
): Announcements {
  function describe(id: string | number) {
    const task = find(String(id));
    return task ? { task, name: taskName(task) } : null;
  }

  return {
    onDragStart({ active }) {
      const d = describe(active.id);
      if (!d) return undefined;
      return `Picked up ${d.name} from ${STATUS_LABEL[d.task.status]}.`;
    },
    onDragOver({ active, over }) {
      const d = describe(active.id);
      if (!d) return undefined;
      const target = columnOf(over?.id);
      if (!target) return `${d.name} is no longer over a column.`;
      if (target === d.task.status) return `${d.name} is back over ${STATUS_LABEL[target]}.`;
      if (!canMoveTo(d.task, viewer, target)) {
        return `${d.name} is over ${STATUS_LABEL[target]}, which can't take it. ${moveDeniedFor(d.task, viewer, target)}`;
      }
      return `${d.name} is over ${STATUS_LABEL[target]}.`;
    },
    onDragEnd({ active, over }) {
      const d = describe(active.id);
      if (!d) return undefined;
      const from = STATUS_LABEL[d.task.status];
      const target = columnOf(over?.id);
      if (!target) return `${d.name} was dropped outside a column. It stays in ${from}.`;
      if (target === d.task.status) return `${d.name} was dropped back in ${from}.`;
      if (!canMoveTo(d.task, viewer, target)) {
        return `Can't move ${d.name} to ${STATUS_LABEL[target]}. ${moveDeniedFor(d.task, viewer, target)} It stays in ${from}.`;
      }
      return `Moved ${d.name} from ${from} to ${STATUS_LABEL[target]}.`;
    },
    onDragCancel({ active }) {
      const d = describe(active.id);
      if (!d) return undefined;
      return `Cancelled. ${d.name} stays in ${STATUS_LABEL[d.task.status]}.`;
    },
  };
}
