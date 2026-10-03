import type { ProjectGraph, Task } from "./types";

/**
 * The task board's filter and grouping state, and the pure functions that read
 * it out of a URL, write it back, and apply it to a list of tasks.
 *
 * The URL is the source of truth, not component state: a filtered board is
 * something people paste into a chat ("here are my open tasks"), and a reload
 * or the back button must land on the same view. Keeping this module free of
 * React and Next means that contract is testable without rendering anything.
 *
 * Every default is *absent* from the URL rather than spelled out, so an
 * unfiltered board keeps the short `?tab=tasks` link it always had.
 */

export type BoardGroup = "none" | "assignee" | "sprint" | "spec";

export interface BoardFilters {
  q: string;
  /** `me`, `unassigned`, or a member's user id; null means everyone. */
  assignee: string | null;
  sprint: string | null;
  spec: string | null;
  group: BoardGroup;
}

export const EMPTY_FILTERS: BoardFilters = {
  q: "",
  assignee: null,
  sprint: null,
  spec: null,
  group: "none",
};

const GROUPS: readonly BoardGroup[] = ["none", "assignee", "sprint", "spec"];

/**
 * The bucket for tasks with no value in the grouped field. Not a plausible
 * sprint name or id, so a sprint literally called "none" still gets its own
 * group.
 */
export const EMPTY_GROUP_KEY = "__none__";

function nonEmpty(value: string | null): string | null {
  return value && value.trim() !== "" ? value : null;
}

export function parseBoardFilters(params: URLSearchParams): BoardFilters {
  const group = params.get("group");
  return {
    q: params.get("q") ?? "",
    assignee: nonEmpty(params.get("assignee")),
    sprint: nonEmpty(params.get("sprint")),
    spec: nonEmpty(params.get("spec")),
    // A hand-edited or stale link degrades to the plain board, not an error.
    group: GROUPS.includes(group as BoardGroup) ? (group as BoardGroup) : "none",
  };
}

/**
 * A copy of `params` carrying `f`. Unknown params (`tab`, `task`, anything a
 * later feature adds) pass through untouched; defaults are deleted.
 */
export function writeBoardFilters(params: URLSearchParams, f: BoardFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  const set = (key: string, value: string | null) => {
    if (value === null || value.trim() === "") next.delete(key);
    else next.set(key, value);
  };
  set("q", f.q);
  set("assignee", f.assignee);
  set("sprint", f.sprint);
  set("spec", f.spec);
  set("group", f.group === "none" ? null : f.group);
  return next;
}

/** Whether anything narrows the task list. Grouping only rearranges it. */
export function hasActiveFilters(f: BoardFilters): boolean {
  return f.q.trim() !== "" || f.assignee !== null || f.sprint !== null || f.spec !== null;
}

/**
 * A task's sprint as the board shows it: trimmed, and null when blank. The
 * sprint options, the sprint filter and the sprint lanes all read it through
 * here, so "Sprint 2 " can't be offered as an option that then matches nothing.
 */
export function sprintOf(task: Task): string | null {
  return task.sprint?.trim() || null;
}

function matchesQuery(task: Task, needle: string): boolean {
  if (task.title.toLowerCase().includes(needle)) return true;
  if (task.feature_tag?.toLowerCase().includes(needle)) return true;
  return task.acceptance_criteria.some((c) => c.text.toLowerCase().includes(needle));
}

function matchesAssignee(task: Task, assignee: string, viewerId: string): boolean {
  if (assignee === "me") return viewerId !== "" && task.assigned_user_id === viewerId;
  if (assignee === "unassigned") return task.assigned_user_id === null;
  return task.assigned_user_id === assignee;
}

/** The subset of `tasks` that `f` admits, in the order given. */
export function applyBoardFilters(tasks: Task[], f: BoardFilters, viewerId: string): Task[] {
  const needle = f.q.trim().toLowerCase();
  return tasks.filter(
    (t) =>
      (needle === "" || matchesQuery(t, needle)) &&
      (f.assignee === null || matchesAssignee(t, f.assignee, viewerId)) &&
      (f.sprint === null || sprintOf(t) === f.sprint.trim()) &&
      (f.spec === null || t.spec_id === f.spec),
  );
}

/**
 * What people call a spec: the title of the requirement it specifies. A spec
 * row has no name of its own. Undefined when the spec isn't in this graph, so
 * the caller decides how to say "missing" in its own context.
 */
export function specLabel(
  graph: Pick<ProjectGraph, "spec_documents" | "requirements">,
  specId: string,
): string | undefined {
  const spec = graph.spec_documents.find((s) => s.id === specId);
  if (!spec) return undefined;
  return graph.requirements.find((r) => r.id === spec.requirement_id)?.title ?? "Untitled spec";
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

const EMPTY_LABEL: Record<Exclude<BoardGroup, "none">, string> = {
  assignee: "Unassigned",
  sprint: "No sprint",
  spec: "No spec",
};

// Numeric collation, so "Sprint 2" comes before "Sprint 10".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Splits `tasks` into swimlanes. Tasks keep their incoming order inside a
 * group (the caller has already sorted them by plan reference); groups sort by
 * label, with the "nothing set" group always last — it is the leftovers, not a
 * peer of the real values. `none` yields one group keyed "all".
 */
export function groupBoardTasks(
  tasks: Task[],
  group: BoardGroup,
  ctx: {
    memberLabel: (userId: string | null) => string;
    specLabel: (specId: string | null) => string;
  },
): TaskGroup[] {
  if (group === "none") return [{ key: "all", label: "All Tasks", tasks }];

  const valueOf = (t: Task): string | null =>
    group === "assignee" ? t.assigned_user_id : group === "sprint" ? sprintOf(t) : t.spec_id;
  const labelOf = (value: string): string =>
    group === "assignee" ? ctx.memberLabel(value) : group === "spec" ? ctx.specLabel(value) : value;

  const buckets = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = valueOf(t) ?? EMPTY_GROUP_KEY;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(t);
    else buckets.set(key, [t]);
  }

  const groups: TaskGroup[] = [];
  let empty: TaskGroup | null = null;
  for (const [key, bucket] of buckets) {
    if (key === EMPTY_GROUP_KEY) {
      empty = { key, label: EMPTY_LABEL[group], tasks: bucket };
    } else {
      groups.push({ key, label: labelOf(key), tasks: bucket });
    }
  }
  // Key breaks label ties, so two members sharing a display name still land in
  // the same order on every render.
  groups.sort(
    (a, b) => collator.compare(a.label, b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  if (empty) groups.push(empty);
  return groups;
}
