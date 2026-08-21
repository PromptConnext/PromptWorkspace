// Workspaces and their projects: cache for instant paint, cloud for truth.
//
// The contract is TaskStore's, deliberately — the two stores back sibling views
// and an inconsistency between them would show as one view claiming to be
// offline while the other silently disagrees. Refresh never rejects, records
// its failure instead, and keeps whatever it had.
//
// One difference: this file owns a plain listener set rather than a
// vscode.EventEmitter, which is what lets `node --test` import it with no
// editor host. TaskStore is not being retrofitted to match; that is unrelated.

import type { CloudClient, LoggerLike } from "../cloud/client.ts";
import { CACHE_FILES, type JsonCache } from "../storage/cache.ts";
import type { RosterEntry } from "./roster.ts";

const FOCUS_REFRESH_THROTTLE_MS = 60_000;

export class RosterStore {
  private entries: RosterEntry[] = [];
  private lastRefreshedAt = 0;
  private lastError: string | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  private readonly client: CloudClient;
  private readonly cache: JsonCache;
  private readonly log: LoggerLike;

  constructor(client: CloudClient, cache: JsonCache, log: LoggerLike) {
    this.client = client;
    this.cache = cache;
    this.log = log;
  }

  all(): RosterEntry[] {
    return this.entries;
  }

  get lastRefreshError(): string | null {
    return this.lastError;
  }

  get refreshedAt(): number {
    return this.lastRefreshedAt;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async loadFromCache(): Promise<void> {
    const cached = await this.cache.read<RosterEntry[]>(CACHE_FILES.roster);
    if (cached && this.entries.length === 0) {
      this.entries = cached;
      this.emit();
    }
  }

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

  async clear(): Promise<void> {
    this.entries = [];
    this.lastRefreshedAt = 0;
    this.lastError = null;
    await this.cache.clear([CACHE_FILES.roster]);
    this.emit();
  }

  private async doRefresh(): Promise<void> {
    try {
      const workspaces = await this.client.listWorkspaces();
      // allSettled, not all: `require_workspace` answers 403 for a membership
      // revoked mid-session, and that is one workspace disappearing — not the
      // roster failing. A rejected member is dropped and logged.
      const settled = await Promise.allSettled(
        workspaces.map(async (workspace) => ({
          workspace,
          projects: await this.client.listWorkspaceProjects(workspace.id),
        })),
      );
      const entries: RosterEntry[] = [];
      settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
          entries.push(result.value);
        } else {
          this.log.warn(
            `roster: dropping workspace ${workspaces[i].id}: ${String(result.reason)}`,
          );
        }
      });
      this.entries = entries;
      this.lastRefreshedAt = Date.now();
      this.lastError = null;
      await this.cache.write(CACHE_FILES.roster, this.entries);
      this.emit();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.info(`roster refresh failed, keeping cache: ${String(err)}`);
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
