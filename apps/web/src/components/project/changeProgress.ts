import type { Task, TaskStatus } from "@/lib/types";

/** The statuses that count a task as done, here and in the server's own
 * per-Change numbers. */
export const DONE_STATUSES: TaskStatus[] = ["implemented", "verified"];

/**
 * A Change's done/total counted from the project graph's tasks.
 *
 * The page polls the graph, while the delivery overview carrying the server's
 * `done`/`total` is fetched once per tab visit, so the numbers shown beside a
 * Change are counted from the graph whenever there is one. A retired task is
 * not a task of the Change (the server's count leaves it out too); the graph
 * already omits them, and `deleted_at` is checked here so the helper is right
 * for any list it is given.
 */
export function changeProgress(
  changeId: string,
  tasks: Task[],
): { done: number; total: number } {
  const live = tasks.filter((t) => t.change_id === changeId && !t.deleted_at);
  return { done: live.filter((t) => DONE_STATUSES.includes(t.status)).length, total: live.length };
}
