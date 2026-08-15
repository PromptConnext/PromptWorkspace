// The task model: cache for instant paint, cloud for truth.
//
// No polling loop. The engine ticked every 20 seconds because it was *pushing*
// a snapshot it owned; a pull-only client has nothing to announce, and ADR 0019
// gives up the always-on process deliberately. Refresh happens on activation,
// on sign-in, on the explicit command, on window focus (throttled), and after a
// status write — every point where the user could plausibly notice staleness.

import * as vscode from "vscode";
import type { CloudClient } from "../cloud/client.ts";
import type { AssignedTask, TaskStatus } from "../cloud/types.ts";
import { CACHE_FILES, type JsonCache } from "../storage/cache.ts";
import type { OutputLogger } from "../util/log.ts";

const FOCUS_REFRESH_THROTTLE_MS = 60_000;

export class TaskStore {
  private tasks: AssignedTask[] = [];
  private lastRefreshedAt = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly emitter = new vscode.EventEmitter<void>();

  readonly onDidChange = this.emitter.event;

  private readonly client: CloudClient;
  private readonly cache: JsonCache;
  private readonly log: OutputLogger;

  constructor(
    client: CloudClient,
    cache: JsonCache,
    log: OutputLogger,
  ) {
    this.client = client;
    this.cache = cache;
    this.log = log;
  }

  all(): AssignedTask[] {
    return this.tasks;
  }

  /** Why the last refresh kept the cache, or null if it succeeded. Background
   *  triggers ignore this — an offline window should not nag. The explicit
   *  Refresh command reads it, because a click that silently does nothing is
   *  indistinguishable from a broken button. */
  get lastRefreshError(): string | null {
    return this.lastError;
  }

  /** Epoch ms of the last *successful* refresh; 0 if there has never been one. */
  get refreshedAt(): number {
    return this.lastRefreshedAt;
  }

  find(taskId: string): AssignedTask | undefined {
    return this.tasks.find((t) => t.task.id === taskId);
  }

  forProject(projectId: string): AssignedTask[] {
    return this.tasks.filter((t) => t.project_id === projectId);
  }

  async loadFromCache(): Promise<void> {
    const cached = await this.cache.read<AssignedTask[]>(CACHE_FILES.tasks);
    if (cached && this.tasks.length === 0) {
      this.tasks = cached;
      this.emitter.fire();
    }
  }

  /** Coalesced: several triggers can fire at once (activation + focus + a
   *  status write completing), and three identical requests help nobody. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refreshOnFocus(): Promise<void> {
    if (Date.now() - this.lastRefreshedAt < FOCUS_REFRESH_THROTTLE_MS) return;
    await this.refresh();
  }

  /** Reflect a write locally before the server confirms it, so the tree does
   *  not lag a click. Rolled back by the caller on a 4xx. */
  applyLocalStatus(taskId: string, status: TaskStatus): TaskStatus | undefined {
    const entry = this.tasks.find((t) => t.task.id === taskId);
    if (!entry) return undefined;
    const previous = entry.task.status;
    entry.task.status = status;
    this.emitter.fire();
    return previous;
  }

  async clear(): Promise<void> {
    this.tasks = [];
    this.lastRefreshedAt = 0;
    await this.cache.clear([CACHE_FILES.tasks]);
    this.emitter.fire();
  }

  private async doRefresh(): Promise<void> {
    try {
      // All four states: the tree shows what is assigned, including work
      // already reported done — a developer wants to see that their commit
      // landed, not watch the row vanish.
      this.tasks = await this.client.listAssignedTasks({
        statuses: ["todo", "in_progress", "implemented", "verified"],
      });
      this.lastRefreshedAt = Date.now();
      this.lastError = null;
      await this.cache.write(CACHE_FILES.tasks, this.tasks);
      this.emitter.fire();
    } catch (err) {
      // Offline is the normal case here, not an error state: the cache is
      // already rendered and the queue holds anything unsent. Recorded rather
      // than thrown so background refreshes stay quiet and the explicit command
      // can still report it.
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.info(`task refresh failed, keeping cache: ${String(err)}`);
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
