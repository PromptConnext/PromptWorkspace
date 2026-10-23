// The local cache: atomic JSON files in the extension's global storage.
//
// ADR 0020 makes the cloud authoritative and the local copy a cache that "may
// be deleted and rebuilt from the cloud without loss" — encoded literally here
// as a schemaVersion that drops the file wholesale on mismatch.
//
// Two rejected alternatives, worth recording so they are not re-proposed:
//
//   node:sqlite — the ABI objection does not apply (it is a built-in, not a
//   .node), but the extension host runs Electron's Node, where the sqlite
//   built-in may be gated behind a runtime flag an extension cannot pass. The
//   editors where that bites are exactly the forks we must support. For a few
//   thousand task rows that is unbounded risk for no benefit.
//
//   Memento (globalState/workspaceState) — shares state.vscdb with
//   SecretStorage ciphertext, is documented for small values, and its writes
//   are fire-and-forget with no atomicity you control. Reserved here for small
//   scalars only (the pending login state, the schema version).

export interface FileStoreLike {
  read(name: string): Promise<string | undefined>;
  write(name: string, contents: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export const CACHE_SCHEMA_VERSION = 1;

interface Envelope<T> {
  schemaVersion: number;
  data: T;
}

export class JsonCache {
  private readonly store: FileStoreLike;
  private readonly nameFor: (name: string) => string;

  /** `nameFor` maps a logical name to the file actually used, read on every
   *  call. apps/vscode keys its per-account files by environment with it
   *  (`scopedFileName`), so a develop window and a trust window never read,
   *  write or clear each other's. The default uses the name as is. */
  constructor(store: FileStoreLike, nameFor: (name: string) => string = (name) => name) {
    this.store = store;
    this.nameFor = nameFor;
  }

  async read<T>(logicalName: string): Promise<T | undefined> {
    const name = this.nameFor(logicalName);
    const raw = await this.store.read(name);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Envelope<T>;
      if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
        // A cache we cannot read is a cache we throw away — it holds nothing
        // that is not also in the cloud.
        await this.store.delete(name).catch(() => undefined);
        return undefined;
      }
      return parsed.data;
    } catch {
      await this.store.delete(name).catch(() => undefined);
      return undefined;
    }
  }

  async write<T>(name: string, data: T): Promise<void> {
    const envelope: Envelope<T> = { schemaVersion: CACHE_SCHEMA_VERSION, data };
    await this.store.write(this.nameFor(name), JSON.stringify(envelope));
  }

  async clear(names: string[]): Promise<void> {
    for (const name of names) {
      await this.store.delete(this.nameFor(name)).catch(() => undefined);
    }
  }
}

export const CACHE_FILES = {
  tasks: "tasks.json",
  queue: "queue.json",
  gitState: "git-state.json",
  roster: "roster.json",
} as const;

export const ALL_CACHE_FILES = Object.values(CACHE_FILES);
