// The ONLY file allowed to import the vendored git.d.ts.
//
// ADR 0019 calls vscode.git the least stable dependency in the stack: absent
// from the published API reference, distributed by "copy this .d.ts", and it
// has changed inside getAPI(1) without deprecation. Feature code therefore
// sees the small interface below and nothing else, so a breaking change
// upstream lands in one file with a typecheck failure rather than everywhere
// at runtime.

import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./git";
import type { LoggerLike } from "@promptworkspace/cloud-client";
import { KeyedDebounce, REMOTE_REF_GLOBS } from "./remoteRefs.ts";

/** How long a burst of remote-ref writes is allowed to settle before one
 *  `status()`. Short: the whole point is to beat the Git extension's own
 *  refresh, and gitWatcher.ts debounces its scan again after the event. */
const REMOTE_REF_SETTLE_MS = 1_000;

export interface RemoteRef {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

/** The branch fields ADR 0022's publication gate reads. `upstream` is the
 *  only one that decides anything on its own: without it there is no remote
 *  to be ahead of, and `ahead` means nothing. */
export interface HeadRef {
  name?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface RepoRef {
  root: vscode.Uri;
  headSha?: string;
  /** Undefined on a detached HEAD, and on a repository with no commits. */
  head?: HeadRef;
  remotes: RemoteRef[];
}

export interface CommitRef {
  sha: string;
  subject: string;
  authorDate?: Date;
}

export interface GitBridge {
  isAvailable(): boolean;
  repositories(): RepoRef[];
  repositoryFor(uri: vscode.Uri): RepoRef | undefined;
  log(root: vscode.Uri, opts: { maxEntries: number }): Promise<CommitRef[]>;
  /** Create and check out a branch. Resolves false when the repository is
   *  gone or git refuses (a name already taken, an unborn HEAD); the caller
   *  reports it, because only the caller knows what the user asked for. */
  createBranch(root: vscode.Uri, name: string): Promise<boolean>;
  /** `git merge-base ref1 ref2`, or undefined when there is none, a ref is
   *  unknown, or this Git API has no `getMergeBase` (an older fork). */
  mergeBase(root: vscode.Uri, ref1: string, ref2: string): Promise<string | undefined>;
  /** Check out an existing branch. Resolves false when git refuses (no such
   *  branch, local changes in the way); the caller reports it. */
  checkout(root: vscode.Uri, name: string): Promise<boolean>;
  /** Pre-fill the Source Control commit message box. Best-effort and silent:
   *  a message the user cannot see us fail to write is not worth a dialog. */
  setCommitMessage(root: vscode.Uri, message: string): void;
  onDidChangeRepositoryState(cb: (repo: RepoRef) => void): vscode.Disposable;
  /** Fires once per repository as `vscode.git` discovers it — including the
   *  cold-start backfill (`onDidChangeState("initialized")`), where discovery
   *  is still running when `getAPI(1)` returns (see the comment on
   *  `activate()` below). It does NOT fire for a repository already present
   *  in `api.repositories` at the moment a listener is registered here — the
   *  listener set is still empty when `activate()` walks that array, so that
   *  case never reaches a callback. Callers that need "this folder has a
   *  repository, right now, even one discovered before I subscribed" (as
   *  `extension.ts` does at activation, for `applyPendingClone`) must check
   *  `repositories()` directly rather than relying on this event alone. */
  onDidOpenRepository(cb: (repo: RepoRef) => void): vscode.Disposable;
  dispose(): void;
}

function toRepoRef(repo: Repository): RepoRef {
  const head = repo.state.HEAD;
  return {
    root: repo.rootUri,
    headSha: head?.commit,
    // `name` is absent on a detached HEAD, which is also exactly when there
    // is no branch to carry a task ref — so a detached HEAD produces a
    // `head` with no name rather than no `head` at all, and the publication
    // gate reads `upstream: undefined` from it and falls back correctly.
    head: head
      ? {
          name: head.name,
          upstream: head.upstream
            ? `${head.upstream.remote}/${head.upstream.name}`
            : undefined,
          ahead: head.ahead,
          behind: head.behind,
        }
      : undefined,
    remotes: repo.state.remotes.map((r) => ({
      name: r.name,
      fetchUrl: r.fetchUrl,
      pushUrl: r.pushUrl,
    })),
  };
}

class VscodeGitBridge implements GitBridge {
  private api: API | undefined;
  private readonly logger: LoggerLike;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly stateListeners = new Set<(repo: RepoRef) => void>();
  private readonly openListeners = new Set<(repo: RepoRef) => void>();
  // `activate()` reaches `watch(repo)` from three paths — the
  // `onDidOpenRepository` subscription, the `onDidChangeState("initialized")`
  // backfill, and the initial `for (const repo of this.api.repositories)`
  // loop — and on a normal cold start the backfill and the initial loop walk
  // the same array. Without this guard the second call would re-register a
  // `repo.state.onDidChange` listener (merely wasteful) AND fire
  // `openListeners` a second time for the same repository, which is what
  // made `extension.ts` invoke `applyPendingClone()` twice concurrently with
  // the same pending record (see projectLink.ts's reentrancy guard).
  private readonly watched = new Set<string>();
  private readonly statusRefresh = new KeyedDebounce(REMOTE_REF_SETTLE_MS);

  constructor(logger: LoggerLike) {
    this.logger = logger;
  }

  async activate(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) {
      this.logger.warn("vscode.git is not installed; git features are disabled");
      return;
    }
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) {
      this.logger.warn("vscode.git is disabled by user settings");
      return;
    }
    this.api = exports.getAPI(1);

    // getAPI(1) returns before repository discovery has finished, so
    // api.repositories is empty on a cold start. Subscribing first, then
    // handling whatever is already open, is what makes this correct in both
    // orders.
    this.disposables.push(
      this.api.onDidOpenRepository((repo) => this.watch(repo)),
      this.api.onDidChangeState((state) => {
        if (state === "initialized") {
          for (const repo of this.api?.repositories ?? []) this.watch(repo);
        }
      }),
    );
    for (const repo of this.api.repositories) this.watch(repo);
  }

  isAvailable(): boolean {
    return this.api !== undefined;
  }

  repositories(): RepoRef[] {
    return (this.api?.repositories ?? []).map(toRepoRef);
  }

  repositoryFor(uri: vscode.Uri): RepoRef | undefined {
    const repo = this.api?.getRepository(uri);
    return repo ? toRepoRef(repo) : undefined;
  }

  async log(root: vscode.Uri, opts: { maxEntries: number }): Promise<CommitRef[]> {
    const repo = this.api?.getRepository(root);
    if (!repo) return [];
    const commits = await repo.log({ maxEntries: opts.maxEntries });
    return commits.map((c) => ({
      sha: c.hash,
      // The engine read `%s`; `message` here is the full message, and its
      // first line is the same subject. Anything past it would match issue
      // references and quoted revert text.
      subject: (c.message ?? "").split("\n", 1)[0].trim(),
      authorDate: c.authorDate,
    }));
  }

  async createBranch(root: vscode.Uri, name: string): Promise<boolean> {
    const repo = this.api?.getRepository(root);
    if (!repo) return false;
    try {
      await repo.createBranch(name, true);
      return true;
    } catch (err) {
      // The common failure is a name already in use, which is not an error
      // worth a stack trace — the caller turns it into a question.
      this.logger.info(`createBranch(${name}) refused: ${String(err)}`);
      return false;
    }
  }

  async mergeBase(root: vscode.Uri, ref1: string, ref2: string): Promise<string | undefined> {
    const repo = this.api?.getRepository(root);
    if (!repo) return undefined;
    try {
      return (await repo.getMergeBase(ref1, ref2)) || undefined;
    } catch {
      // Unknown ref (no `origin/main` in this clone) is the common case: the
      // caller tries the next candidate and logs once if none resolves.
      return undefined;
    }
  }

  async checkout(root: vscode.Uri, name: string): Promise<boolean> {
    const repo = this.api?.getRepository(root);
    if (!repo) return false;
    try {
      await repo.checkout(name);
      return true;
    } catch (err) {
      this.logger.info(`checkout(${name}) refused: ${String(err)}`);
      return false;
    }
  }

  setCommitMessage(root: vscode.Uri, message: string): void {
    const repo = this.api?.getRepository(root);
    if (!repo) return;
    // Never clobber a message the developer is already writing.
    if (repo.inputBox.value.trim().length > 0) return;
    repo.inputBox.value = message;
  }

  onDidChangeRepositoryState(cb: (repo: RepoRef) => void): vscode.Disposable {
    this.stateListeners.add(cb);
    return new vscode.Disposable(() => this.stateListeners.delete(cb));
  }

  onDidOpenRepository(cb: (repo: RepoRef) => void): vscode.Disposable {
    this.openListeners.add(cb);
    return new vscode.Disposable(() => this.openListeners.delete(cb));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.stateListeners.clear();
    this.openListeners.clear();
    this.watched.clear();
    this.statusRefresh.dispose();
  }

  private watch(repo: Repository): void {
    // Every code path that finds a repository — already open at cold start,
    // discovered later by `onDidOpenRepository`, or backfilled once the API
    // reports "initialized" — funnels through here, so this is the one place
    // that needs to fire the "opened" notification for all three. Two of
    // those three paths can name the same repository on one cold start (the
    // backfill loop and the initial loop both walk `api.repositories`), so
    // this has to be idempotent per repository rather than per call.
    const key = repo.rootUri.toString();
    if (this.watched.has(key)) return;
    this.watched.add(key);
    const ref = toRepoRef(repo);
    for (const listener of this.openListeners) listener(ref);
    this.disposables.push(
      repo.state.onDidChange(() => {
        const changed = toRepoRef(repo);
        for (const listener of this.stateListeners) listener(changed);
      }),
    );
    this.watchRemoteRefs(repo, key);
  }

  /** Finding #44: a push or fetch made in a terminal rewrites these files;
   *  asking for a fresh status recomputes `ahead`, and the resulting state
   *  event reaches gitWatcher.ts like any other. Best-effort: a watcher the
   *  host refuses costs us only the speed-up. */
  private watchRemoteRefs(repo: Repository, key: string): void {
    const refresh = () =>
      this.statusRefresh.trigger(key, () => {
        repo.status().catch((err: unknown) => {
          this.logger.info(`status refresh after a remote-ref change failed: ${String(err)}`);
        });
      });
    for (const glob of REMOTE_REF_GLOBS) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(repo.rootUri, glob),
        );
        this.disposables.push(
          watcher,
          watcher.onDidCreate(refresh),
          watcher.onDidChange(refresh),
          watcher.onDidDelete(refresh),
        );
      } catch (err) {
        this.logger.info(`cannot watch ${glob} in ${repo.rootUri.fsPath}: ${String(err)}`);
      }
    }
  }
}

class NoopGitBridge implements GitBridge {
  isAvailable(): boolean {
    return false;
  }
  repositories(): RepoRef[] {
    return [];
  }
  repositoryFor(): RepoRef | undefined {
    return undefined;
  }
  async log(): Promise<CommitRef[]> {
    return [];
  }
  async createBranch(): Promise<boolean> {
    return false;
  }
  async mergeBase(): Promise<string | undefined> {
    return undefined;
  }
  async checkout(): Promise<boolean> {
    return false;
  }
  setCommitMessage(): void {
    /* no git extension, no commit box */
  }
  onDidChangeRepositoryState(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
  onDidOpenRepository(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
  dispose(): void {
    /* nothing to release */
  }
}

export async function createGitBridge(log: LoggerLike): Promise<GitBridge> {
  const bridge = new VscodeGitBridge(log);
  try {
    await bridge.activate();
  } catch (err) {
    // A git extension that fails to activate must degrade the git features,
    // never the task list.
    log.error(`vscode.git activation failed: ${String(err)}`);
    return new NoopGitBridge();
  }
  return bridge.isAvailable() ? bridge : new NoopGitBridge();
}
