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

import type { StatusArtifact, TaskStatus } from "../cloud/types.ts";

export interface QueueEntry {
  id: string;
  projectId: string;
  taskId: string;
  status: TaskStatus;
  artifact?: StatusArtifact;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export type QueueFlusher = (entry: QueueEntry) => Promise<void>;

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
    this.entries = (await this.deps.load()) ?? [];
    this.loaded = true;
  }

  size(): number {
    return this.entries.length;
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
    await this.load();
    const now = this.deps.now();
    const existing = this.entries.findIndex(
      (e) => e.taskId === entry.taskId && e.projectId === entry.projectId,
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
   * up a queue that is otherwise flushable.
   */
  async flush(flusher: QueueFlusher): Promise<{ sent: number; failed: number }> {
    await this.load();
    const now = this.deps.now();
    let sent = 0;
    let failed = 0;
    const survivors: QueueEntry[] = [];

    for (const entry of this.entries) {
      if (entry.attempts >= MAX_ATTEMPTS || entry.nextAttemptAt > now) {
        survivors.push(entry);
        continue;
      }
      try {
        await flusher(entry);
        sent += 1;
      } catch (err) {
        failed += 1;
        const attempts = entry.attempts + 1;
        survivors.push({
          ...entry,
          attempts,
          nextAttemptAt: now + (BACKOFF_MS[attempts - 1] ?? 0),
          // Keep the error off the entry: it is transient by definition, and
          // persisting it would grow the file without helping anyone.
        });
        void err;
      }
    }

    this.entries = survivors;
    await this.persist();
    return { sent, failed };
  }

  /** Drop a parked entry's attempt count so an explicit retry actually runs. */
  async retryAll(): Promise<void> {
    await this.load();
    const now = this.deps.now();
    this.entries = this.entries.map((e) => ({ ...e, attempts: 0, nextAttemptAt: now }));
    await this.persist();
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
