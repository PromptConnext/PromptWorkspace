// The ONLY file allowed to import the vendored git.d.ts.
//
// ADR 0019 calls vscode.git the least stable dependency in the stack: absent
// from the published API reference, distributed by "copy this .d.ts", and it
// has changed inside getAPI(1) without deprecation. Feature code therefore
// sees the four-method interface below and nothing else, so a breaking change
// upstream lands in one file with a typecheck failure rather than everywhere
// at runtime.

import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./git";
import type { LoggerLike } from "../cloud/client.ts";

export interface RemoteRef {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface RepoRef {
  root: vscode.Uri;
  headSha?: string;
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
  onDidChangeRepositoryState(cb: (repo: RepoRef) => void): vscode.Disposable;
  dispose(): void;
}

function toRepoRef(repo: Repository): RepoRef {
  return {
    root: repo.rootUri,
    headSha: repo.state.HEAD?.commit,
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

  onDidChangeRepositoryState(cb: (repo: RepoRef) => void): vscode.Disposable {
    this.stateListeners.add(cb);
    return new vscode.Disposable(() => this.stateListeners.delete(cb));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.stateListeners.clear();
  }

  private watch(repo: Repository): void {
    this.disposables.push(
      repo.state.onDidChange(() => {
        const ref = toRepoRef(repo);
        for (const listener of this.stateListeners) listener(ref);
      }),
    );
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
  onDidChangeRepositoryState(): vscode.Disposable {
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
