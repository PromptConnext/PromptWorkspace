// Noticing a push made outside the editor (finding #44).
//
// The close-on-push gate reads `ahead` from the Git extension, which only
// recomputes it when it refreshes. A `git push` from a terminal rewrites the
// remote-tracking ref (`.git/refs/remotes/<remote>/<branch>`, or
// `packed-refs`) and a fetch rewrites `FETCH_HEAD`, but in some editors (Cursor
// in the trust test) the Git extension did not refresh for a minute or more, so
// the task sat "commit not pushed". gitBridge.ts watches these files and calls
// `repository.status()`, which recomputes `ahead` and fires the state event
// gitWatcher.ts already scans on.
//
// No `vscode` import: the globs and the per-repository debounce are tested
// here; the watcher itself is glue.

/** Relative to the repository root. A linked worktree or submodule has a
 *  `.git` FILE, not a directory, and is not covered; those keep relying on the
 *  Git extension's own refresh. */
export const REMOTE_REF_GLOBS: readonly string[] = [
  ".git/refs/remotes/**",
  ".git/FETCH_HEAD",
  ".git/packed-refs",
];

export interface TimerLike {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: TimerLike = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Trailing-edge debounce per key: one fetch rewrites a ref per remote branch,
 *  and one `status()` per burst is enough. */
export class KeyedDebounce {
  private readonly handles = new Map<string, unknown>();
  private readonly delayMs: number;
  private readonly timers: TimerLike;

  constructor(delayMs: number, timers: TimerLike = REAL_TIMERS) {
    this.delayMs = delayMs;
    this.timers = timers;
  }

  trigger(key: string, fn: () => void): void {
    const existing = this.handles.get(key);
    if (existing !== undefined) this.timers.clear(existing);
    this.handles.set(
      key,
      this.timers.set(() => {
        this.handles.delete(key);
        fn();
      }, this.delayMs),
    );
  }

  dispose(): void {
    for (const handle of this.handles.values()) this.timers.clear(handle);
    this.handles.clear();
  }
}
