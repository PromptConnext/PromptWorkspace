import type { Task } from "./types";

/**
 * Display order for the task board.
 *
 * The wire order is not a display order. `GET /sync/projects/{id}/graph` sorts
 * every entity by `(updated_at, id)` because that pair is the keyset the
 * paginated pull walks — correct for sync, wrong for a board, because the
 * moment you assign a task its `updated_at` bumps and it teleports to the
 * bottom of the list. Nothing about the task changed except who owns it.
 *
 * So the client sorts, and it sorts by something a write cannot move: the Spec
 * Kit reference the tasks stage stamps into `feature_tag` (`T001`, `T002 [P]`,
 * see `_persist_tasks` in apps/cloud). That reference is the plan's own
 * sequence, which is exactly the order a reader expects to see steps in.
 *
 * `feature_tag` is *shared* authority though — a connected tracker can write
 * anything into it — so a tag that is not a `T###`-shaped reference sorts after
 * the ones that are, alphabetically, with `id` as the final tiebreak. Every
 * comparison is total and depends only on immutable fields, which is what makes
 * the order stable across refetches.
 */

const REF_RE = /^\s*([A-Za-z]*)(\d+)/;

/**
 * Three tiers, in the order they belong on screen: the plan's own sequence
 * first, then whatever else a tracker wrote into the tag, then the tasks
 * carrying no tag at all. Tiering is what stops an empty string from sorting
 * ahead of real text the way a plain string compare would put it.
 */
const TIER = { reference: 0, other: 1, untagged: 2 } as const;

interface RefKey {
  tier: (typeof TIER)[keyof typeof TIER];
  prefix: string;
  seq: number;
  /** The reference exactly as written, so rendering never restates it. */
  text: string;
  raw: string;
}

export function taskRefKey(task: Task): RefKey {
  const raw = task.feature_tag ?? "";
  const m = REF_RE.exec(raw);
  if (!m) {
    const tier = raw.trim() === "" ? TIER.untagged : TIER.other;
    return { tier, prefix: "", seq: 0, text: "", raw };
  }
  return {
    tier: TIER.reference,
    prefix: m[1].toUpperCase(),
    seq: Number(m[2]),
    text: `${m[1]}${m[2]}`,
    raw,
  };
}

export function compareTasks(a: Task, b: Task): number {
  const ka = taskRefKey(a);
  const kb = taskRefKey(b);
  if (ka.tier !== kb.tier) return ka.tier - kb.tier;
  if (ka.tier === TIER.reference) {
    if (ka.prefix !== kb.prefix) return ka.prefix < kb.prefix ? -1 : 1;
    // Numeric, so T2 precedes T10 the way a reader reads them.
    if (ka.seq !== kb.seq) return ka.seq - kb.seq;
  } else if (ka.raw !== kb.raw) {
    return ka.raw < kb.raw ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

/**
 * The short reference to print on a card ("T004"), or null when `feature_tag`
 * holds something else. The `[P]` parallel marker is dropped: it describes the
 * plan's execution strategy, not the card's identity.
 */
export function taskRefLabel(task: Task): string | null {
  const key = taskRefKey(task);
  return key.tier === TIER.reference ? key.text : null;
}
