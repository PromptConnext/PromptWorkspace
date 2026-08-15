import type { Task, TaskStatus } from "@/lib/types";

/**
 * The board's copy of the rules `assign_task` and `set_task_status` enforce in
 * apps/cloud/app/api/sync.py. These gates are UX only — the server re-checks
 * every write and is the thing actually protecting the data.
 *
 * They matter more than they used to. The board now writes optimistically, so
 * an action the server was always going to reject is no longer a disabled
 * control quietly doing nothing; it is a card that visibly moves and then snaps
 * back. Offering only what will succeed is what keeps that from happening.
 */

export interface Viewer {
  userId: string;
  role: string | undefined;
}

export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/** A member may claim an unassigned task, or release one they hold. */
export function canAssign(task: Task, viewer: Viewer): boolean {
  if (isAdmin(viewer)) return true;
  return task.assigned_user_id === null || task.assigned_user_id === viewer.userId;
}

/**
 * Which user ids a viewer may write into `assigned_user_id`. Admins pick any
 * member; everyone else picks themselves or nobody, mirroring the
 * self_assign / self_unassign pair the endpoint accepts.
 */
export function assignableUserIds(viewer: Viewer, memberIds: string[]): string[] {
  return isAdmin(viewer) ? memberIds : memberIds.filter((id) => id === viewer.userId);
}

export function canMoveTo(task: Task, viewer: Viewer, target: TaskStatus): boolean {
  if (isAdmin(viewer)) return true;
  if (task.assigned_user_id !== viewer.userId) return false;
  // `verified` is a review state: a developer reports implementation, someone
  // else confirms it. The endpoint returns 403 verified_requires_admin here.
  return target !== "verified";
}

/** Any legal destination at all — false means the card should not drag. */
export function canMoveAnywhere(task: Task, viewer: Viewer, columns: TaskStatus[]): boolean {
  return columns.some((s) => s !== task.status && canMoveTo(task, viewer, s));
}

export function moveDeniedReason(task: Task, viewer: Viewer): string {
  if (task.assigned_user_id === null) return "Assign this task to yourself before moving it";
  return "Only the assignee or a workspace admin can move this task";
}
