// Pending status writes, held across restarts.
//
// ADR 0020 decision 4: offline is read-only-plus-queue, not local authority.
// A developer offline keeps working in git; status changes queue and flush on
// reconnect.
//
// Two rules that keep this from becoming the classic broken retry queue:
//   * Entries dedupe by task id. Status is a scalar, so last write wins, and
//     that is exactly what makes replay safe.
//   * A 4xx never enters the queue (see statusWriter). A 403 or 404 will not
//     succeed on the tenth attempt either.

import type { StatusArtifact, TaskStatus } from "./types.ts";

export interface QueueEntry {
  id: string;
  projectId: string;
  taskId: string;
  status: TaskStatus;
  artifact?: StatusArtifact;
  /** Environment the write was made against (a host such as `abc.supabase.co`).
   *  Absent on entries queued before this field existed, and from apps/mcp. */
  scope?: string;
  /** Cloud user who made the write. Absent under the same conditions. */
  userId?: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export type QueueFlusher = (entry: QueueEntry) => Promise<void>;

/** An entry with no owner recorded belongs to everyone, so a queue written
 *  before scope and user existed still flushes. */
export function belongsTo(
  scope: string,
  userId: string | undefined,
): (e: QueueEntry) => boolean {
  return (e) =>
    (e.scope === undefined || e.scope === scope) &&
    (e.userId === undefined || e.userId === userId);
}

/** Backoff, then park. Parking is deliberate: an entry that has failed four
 *  times needs a human to look, not a tighter loop. */
const BACKOFF_MS = [5_000, 30_000, 300_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

export interface StatusQueueDeps {
  load: () => Promise<QueueEntry[] | undefined>;
  save: (entries: QueueEntry[]) => Promise<void>;
  now: () => number;
  /** Injected so tests need no randomness; the extension passes randomUUID. */
  newId: () => string;
}

export class StatusQueue {
  private entries: QueueEntry[] = [];
  private loaded = false;
  private readonly deps: StatusQueueDeps;

  constructor(deps: StatusQueueDeps) {
    this.deps = deps;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.reload();
  }

  /** Every window of one editor profile shares the queue file, so each write
   *  starts from what is on disk now, not from this window's last read. Saving
   *  a stale copy would erase whatever another window queued since. */
  private async reload(): Promise<void> {
    this.entries = (await this.deps.load()) ?? [];
    this.loaded = true;
  }

  size(): number {
    return this.entries.length;
  }

  count(belongs?: (e: QueueEntry) => boolean): number {
    return belongs ? this.entries.filter(belongs).length : this.entries.length;
  }

  parked(): QueueEntry[] {
    return this.entries.filter((e) => e.attempts >= MAX_ATTEMPTS);
  }

  list(): QueueEntry[] {
    return [...this.entries];
  }

  async enqueue(
    entry: Omit<QueueEntry, "id" | "enqueuedAt" | "attempts" | "nextAttemptAt">,
  ): Promise<void> {
    await this.reload();
    const now = this.deps.now();
    const existing = this.entries.findIndex(
      (e) =>
        e.taskId === entry.taskId &&
        e.projectId === entry.projectId &&
        e.scope === entry.scope,
    );
    const next: QueueEntry = {
      ...entry,
      id: this.deps.newId(),
      enqueuedAt: now,
      attempts: 0,
      nextAttemptAt: now,
    };
    if (existing >= 0) {
      // Supersede rather than append: the newest status is the true one, and a
      // queue that replayed both would flap the task through an old state.
      next.artifact = entry.artifact ?? this.entries[existing].artifact;
      this.entries[existing] = next;
    } else {
      this.entries.push(next);
    }
    await this.persist();
  }

  /**
   * Attempt every entry that is due. A failure backs the entry off rather than
   * blocking the ones behind it — a single unreachable project must not hold
   * up a queue that is otherwise flushable. Entries `belongs` rejects are left
   * untouched: no attempt, no backoff change.
   */
  async flush(
    flusher: QueueFlusher,
    belongs?: (e: QueueEntry) => boolean,
  ): Promise<{ sent: number; failed: number }> {
    await this.reload();
    const now = this.deps.now();
    const sent = new Set<string>();
    const failed = new Map<string, QueueEntry>();

    for (const entry of this.entries) {
      if (
        (belongs && !belongs(entry)) ||
        entry.attempts >= MAX_ATTEMPTS ||
        entry.nextAttemptAt > now
      ) {
        continue;
      }
      try {
        await flusher(entry);
        sent.add(entry.id);
      } catch (err) {
        const attempts = entry.attempts + 1;
        failed.set(entry.id, {
          ...entry,
          attempts,
          nextAttemptAt: now + (BACKOFF_MS[attempts - 1] ?? 0),
          // Keep the error off the entry: it is transient by definition, and
          // persisting it would grow the file without helping anyone.
        });
        void err;
      }
    }

    // Merge by id into the file as it is now: the sends took time, and
    // another window (or this one) may have queued or superseded entries
    // meanwhile. A superseded entry has a new id, so it is kept.
    await this.reload();
    this.entries = this.entries
      .filter((e) => !sent.has(e.id))
      .map((e) => failed.get(e.id) ?? e);
    await this.persist();
    return { sent: sent.size, failed: failed.size };
  }

  /** Drop a parked entry's attempt count so an explicit retry actually runs. */
  async retryAll(): Promise<void> {
    await this.reload();
    const now = this.deps.now();
    this.entries = this.entries.map((e) => ({ ...e, attempts: 0, nextAttemptAt: now }));
    await this.persist();
  }

  /** Remove the entries `predicate` matches; returns how many went. */
  async drop(predicate: (e: QueueEntry) => boolean): Promise<number> {
    await this.reload();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !predicate(e));
    await this.persist();
    return before - this.entries.length;
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.loaded = true;
    await this.persist();
  }

  private persist(): Promise<void> {
    return this.deps.save(this.entries);
  }
}
