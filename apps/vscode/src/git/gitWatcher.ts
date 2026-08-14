// Commit -> task status. The headline feature, and the reason ADR 0019 exists
// in the shape it does: a developer writes "T3: add retry", pushes, and the
// task closes in the cloud with no context switch at all.
//
// The engine did this as a scan-on-read: `git log -n 300` re-parsed on every
// graph fetch (apps/engine/src/routes/projects.ts:751). Two things change here.
//
// TRIGGER — repository state-change events, debounced, instead of a scan
// whenever someone happened to open a view.
//
// WINDOW — the fixed 300-commit constant is replaced by "what we have not
// already seen": remember HEAD and a bounded ring of recent shas, read one
// page, and stop at the first sha already in the ring. The constant survives
// only to bound a repository's first run and a history rewrite. Being lossy at
// the edges is safe because the cloud makes artifact writes idempotent on
// (task_id, commit_sha) — a replay after a cache loss costs one request and
// creates nothing.

import * as vscode from "vscode";
import type { AssignedTask } from "../cloud/types.ts";
import { isClosed } from "../cloud/types.ts";
import type { ProjectLink } from "../link/projectLink.ts";
import { CACHE_FILES, type JsonCache } from "../storage/cache.ts";
import type { StatusWriter } from "../tasks/statusWriter.ts";
import type { TaskStore } from "../tasks/taskStore.ts";
import type { OutputLogger } from "../util/log.ts";
import type { GitBridge, RepoRef } from "./gitBridge.ts";
import { collidingRefs, taskRefFromFeatureTag, taskRefsInSubject } from "./taskRefs.ts";

const DEBOUNCE_MS = 1_500;
const PAGE_SIZE = 100;
const SEEN_RING = 5_000;

interface RepoState {
  lastScannedHeadSha?: string;
  seenShas: string[];
}

type GitStateFile = Record<string, RepoState>;

export class GitWatcher {
  private state: GitStateFile = {};
  private loaded = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly git: GitBridge;
  private readonly store: TaskStore;
  private readonly writer: StatusWriter;
  private readonly link: ProjectLink;
  private readonly cache: JsonCache;
  private readonly log: OutputLogger;
  private readonly enabled: () => boolean;
  private readonly scanLimit: () => number;

  constructor(
    git: GitBridge,
    store: TaskStore,
    writer: StatusWriter,
    link: ProjectLink,
    cache: JsonCache,
    log: OutputLogger,
    enabled: () => boolean,
    scanLimit: () => number,
  ) {
    this.git = git;
    this.store = store;
    this.writer = writer;
    this.link = link;
    this.cache = cache;
    this.log = log;
    this.enabled = enabled;
    this.scanLimit = scanLimit;
  }

  start(): void {
    this.disposables.push(
      this.git.onDidChangeRepositoryState((repo) => this.schedule(repo)),
    );
    void this.scanAll();
  }

  async scanAll(): Promise<void> {
    for (const repo of this.git.repositories()) await this.scan(repo);
  }

  private schedule(repo: RepoRef): void {
    const key = repo.root.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    // A commit fires several state changes (index, HEAD, refs); one scan is
    // enough for all of them.
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.scan(repo);
      }, DEBOUNCE_MS),
    );
  }

  private async scan(repo: RepoRef): Promise<void> {
    if (!this.enabled()) return;
    await this.loadState();

    const key = repo.root.toString();
    const projectId = this.link.projectIdForRepoRoot(repo.root);
    if (!projectId) {
      this.logOnce(key, `${repo.root.fsPath} is not linked to a project; skipping`);
      return;
    }

    const state = this.state[key] ?? { seenShas: [] };
    if (repo.headSha && state.lastScannedHeadSha === repo.headSha) return;

    const seen = new Set(state.seenShas);
    const firstRun = state.seenShas.length === 0;
    let commits = await this.git.log(repo.root, {
      maxEntries: firstRun ? this.scanLimit() : PAGE_SIZE,
    });

    // Everything on the first page is new: history was rewritten, or the
    // developer committed a great deal between windows. Widen once.
    if (!firstRun && commits.length > 0 && commits.every((c) => !seen.has(c.sha))) {
      commits = await this.git.log(repo.root, { maxEntries: this.scanLimit() });
    }

    const fresh = [];
    for (const commit of commits) {
      if (seen.has(commit.sha)) break;
      fresh.push(commit);
    }

    if (fresh.length > 0) await this.closeFrom(projectId, fresh);

    this.state[key] = {
      lastScannedHeadSha: repo.headSha,
      seenShas: [...commits.map((c) => c.sha), ...state.seenShas].slice(0, SEEN_RING),
    };
    await this.cache.write(CACHE_FILES.gitState, this.state);
  }

  private async closeFrom(
    projectId: string,
    commits: { sha: string; subject: string }[],
  ): Promise<void> {
    const tasks = this.store.forProject(projectId);
    if (tasks.length === 0) return;

    // Numeric normalisation makes T012 and T12 the same ref. If a project
    // genuinely contains both as distinct tasks, neither can be auto-closed —
    // guessing which one the developer meant is worse than doing nothing.
    const collisions = collidingRefs(tasks.map((t) => t.task.feature_tag));
    const byRef = new Map<string, AssignedTask>();
    for (const entry of tasks) {
      const ref = taskRefFromFeatureTag(entry.task.feature_tag);
      if (ref && !collisions.has(ref)) byRef.set(ref, entry);
    }

    for (const commit of [...commits].reverse()) {
      for (const ref of taskRefsInSubject(commit.subject)) {
        if (collisions.has(ref)) {
          this.log.warn(
            `${ref} matches more than one task in this project; not closing either`,
          );
          continue;
        }
        const entry = byRef.get(ref);
        if (!entry) continue;
        if (isClosed(entry.task.status)) continue;

        const me = this.currentUserId();
        if (entry.task.assigned_user_id && me && entry.task.assigned_user_id !== me) {
          // The cloud would 403 this. Filtering here keeps a doomed entry out
          // of the queue and tells the developer why.
          this.log.info(
            `${ref} matched but is assigned to someone else; skipping`,
          );
          continue;
        }

        await this.writer.setStatus({
          projectId,
          taskId: entry.task.id,
          // A commit is evidence of implementation, not of verification.
          status: "implemented",
          artifact: {
            commit_sha: commit.sha,
            // Same shape the engine wrote, so artifacts from either client
            // look identical in apps/web.
            uri: `git: ${commit.subject.slice(0, 100)}`,
            kind: "code",
          },
          silent: true,
        });
        this.log.info(`closed ${ref} from ${commit.sha.slice(0, 8)}`);
      }
    }
  }

  private currentUserId(): string | undefined {
    // The tasks come from /me/tasks, so anything in the store is already
    // assigned to the caller or unassigned; this is belt-and-braces for the
    // multi-account case where a cached list outlives a sign-out.
    return this.store.all()[0]?.task.assigned_user_id ?? undefined;
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.state = (await this.cache.read<GitStateFile>(CACHE_FILES.gitState)) ?? {};
    this.loaded = true;
  }

  private readonly loggedOnce = new Set<string>();
  private logOnce(key: string, message: string): void {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.log.info(message);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
  }
}
