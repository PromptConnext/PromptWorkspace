// Commit -> pending -> push -> task status. The headline feature, and the
// reason ADR 0019 exists in the shape it does: a developer writes "T3: add
// retry", pushes, and the task closes in the cloud with no context switch at
// all.
//
// The engine did this as a scan-on-read: `git log -n 300` re-parsed on every
// graph fetch (apps/engine/src/routes/projects.ts:751). Three things change.
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
//
// PUBLICATION — ADR 0022. A commit is not evidence of implementation until the
// team can fetch it, so a matched commit enters a local pending list and stays
// there, with no cloud write of any kind, until the branch reports it pushed.
// A push changes `ahead` without changing HEAD, so the early return has to
// watch both or a push would look like nothing happened.

import * as vscode from "vscode";
import type { AssignedTask } from "@promptworkspace/cloud-client";
import { isClosed } from "@promptworkspace/cloud-client";
import type { CloseTasksOn } from "../config.ts";
import type { ProjectLink } from "../link/projectLink.ts";
import { CACHE_FILES, type JsonCache } from "@promptworkspace/cloud-client";
import type { StatusWriter } from "../tasks/statusWriter.ts";
import type { TaskStore } from "../tasks/taskStore.ts";
import type { OutputLogger } from "../util/log.ts";
import type { CommitRef, GitBridge, RepoRef } from "./gitBridge.ts";
import { aheadOf, partitionWithHeld } from "./publication.ts";
import { attributeCommits, mergeBaseCandidates } from "./divergence.ts";
import {
  collidingRefs,
  taskRefFromBranch,
  taskRefFromFeatureTag,
} from "@promptworkspace/cloud-client";

const DEBOUNCE_MS = 1_500;
const PAGE_SIZE = 100;
const SEEN_RING = 5_000;

// A developer with two hundred unpushed commits carrying task refs has a
// bigger problem than this cache. Bounding it keeps one runaway repository
// from growing the state file without limit.
const PENDING_CAP = 200;

// Used only when the roster has no answer for a project's default branch —
// an unlinked-but-known repo, or a roster that has never reached the cloud.
// Attributing every commit on `main` to a task called "T1" is worse than
// missing an attribution, so this errs toward missing one.
const ASSUMED_DEFAULT_BRANCHES = new Set(["main", "master"]);

/** A matched commit waiting to be published. Refs are resolved at discovery
 *  time, not at close time: the branch that gives a commit its ref is the one
 *  HEAD was on when the commit appeared, and the developer may have moved on
 *  by the time it reaches the remote. */
interface PendingCommit {
  sha: string;
  subject: string;
  refs: string[];
  /** Published, but its close was not written (no session, or the task list
   *  had not loaded). Retried on the next scan; never shown as unpushed. */
  held?: boolean;
}

interface RepoState {
  lastScannedHeadSha?: string;
  /** null means "no upstream", which is distinct from "not yet scanned".
   *  Written as null rather than left undefined so it survives JSON. */
  lastAhead?: number | null;
  seenShas: string[];
  pending?: PendingCommit[];
}

type GitStateFile = Record<string, RepoState>;

export class GitWatcher {
  private state: GitStateFile = {};
  private loaded = false;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  /** projectId -> task refs with a committed-but-unpushed commit. Rebuilt on
   *  every scan rather than persisted: it is a projection of `state.pending`,
   *  and a second copy on disk could only ever disagree with the first. */
  private readonly pendingByProject = new Map<string, Set<string>>();
  private readonly pendingEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangePending = this.pendingEmitter.event;

  private readonly git: GitBridge;
  private readonly store: TaskStore;
  private readonly writer: StatusWriter;
  private readonly link: ProjectLink;
  private readonly cache: JsonCache;
  private readonly log: OutputLogger;
  private readonly enabled: () => boolean;
  private readonly scanLimit: () => number;
  private readonly closeOn: () => CloseTasksOn;
  private readonly defaultBranchFor: (projectId: string) => string | null;
  private readonly isSignedIn: () => boolean;

  constructor(
    git: GitBridge,
    store: TaskStore,
    writer: StatusWriter,
    link: ProjectLink,
    cache: JsonCache,
    log: OutputLogger,
    enabled: () => boolean,
    scanLimit: () => number,
    closeOn: () => CloseTasksOn,
    defaultBranchFor: (projectId: string) => string | null,
    isSignedIn: () => boolean,
  ) {
    this.git = git;
    this.store = store;
    this.writer = writer;
    this.link = link;
    this.cache = cache;
    this.log = log;
    this.enabled = enabled;
    this.scanLimit = scanLimit;
    this.closeOn = closeOn;
    this.defaultBranchFor = defaultBranchFor;
    this.isSignedIn = isSignedIn;
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

  /** Task refs in this project holding a commit that has not been pushed.
   *  Read by the task tree, which is the only feedback a developer gets that
   *  their reference parsed at all before the push lands. */
  pendingRefsFor(projectId: string): ReadonlySet<string> {
    return this.pendingByProject.get(projectId) ?? EMPTY_REFS;
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

  /** One scan at a time per repository. Several triggers can overlap now (the
   *  debounce, startup, sign-in, the task list loading), and two scans over
   *  the same stale `state` would race to write it. */
  private readonly scanning = new Map<string, Promise<void>>();

  private scan(repo: RepoRef): Promise<void> {
    const key = repo.root.toString();
    const run = (this.scanning.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.scanNow(repo));
    this.scanning.set(key, run);
    return run;
  }

  private async scanNow(repo: RepoRef): Promise<void> {
    if (!this.enabled()) return;
    await this.loadState();

    const key = repo.root.toString();
    const projectId = this.link.projectIdForRepoRoot(repo.root);
    if (!projectId) {
      this.logOnce(key, `${repo.root.fsPath} is not linked to a project; skipping`);
      return;
    }

    const state = this.state[key] ?? { seenShas: [], pending: [] };

    // In `commit` mode there is no gate at all, which reduces the partition
    // below to "everything is published" — the pre-0.3 behaviour, expressed
    // as a configuration of the new path rather than a second code path.
    const gated = this.closeOn() === "push";
    const ahead = gated ? aheadOf(repo.head) : undefined;
    if (gated && ahead === undefined) {
      this.logOnce(
        `${key}:no-upstream`,
        `${repo.root.fsPath} has no upstream branch; closing tasks at commit ` +
          "time until one is set",
      );
    }

    const aheadKey = ahead ?? null;
    const headUnchanged =
      repo.headSha !== undefined && state.lastScannedHeadSha === repo.headSha;
    const aheadUnchanged = (state.lastAhead ?? null) === aheadKey;
    // Both, not either: a push moves `ahead` and leaves HEAD alone, and an
    // amend moves HEAD and leaves `ahead` alone.
    // Not while commits are held: a held commit is published but its close has
    // not been written yet (no session, or the tasks had not loaded), and
    // nothing in git will change to prompt another look at it.
    if (headUnchanged && aheadUnchanged && !(state.pending ?? []).some((p) => p.held)) return;

    let commits: CommitRef[] = [];
    let fresh: CommitRef[] = [];

    if (!headUnchanged) {
      const seen = new Set(state.seenShas);
      const firstRun = state.seenShas.length === 0;
      commits = await this.git.log(repo.root, {
        maxEntries: firstRun ? this.scanLimit() : PAGE_SIZE,
      });

      // Everything on the first page is new: history was rewritten, or the
      // developer committed a great deal between windows. Widen once.
      if (!firstRun && commits.length > 0 && commits.every((c) => !seen.has(c.sha))) {
        commits = await this.git.log(repo.root, { maxEntries: this.scanLimit() });
      }

      for (const commit of commits) {
        if (seen.has(commit.sha)) break;
        fresh.push(commit);
      }
    } else if (ahead !== undefined && ahead > 0) {
      // A partial push, or a fetch that moved the upstream. HEAD is where we
      // left it, so nothing is newly matched, but the partition needs the log
      // to know which shas are still in the ahead window.
      commits = await this.git.log(repo.root, { maxEntries: PAGE_SIZE });
    }

    const branchRef = this.branchRefFor(repo, projectId);
    // #41: the branch's ref covers only commits after it left the default
    // branch, never the history it inherited.
    const base =
      branchRef && fresh.length > 0 ? await this.branchPoint(repo, projectId) : undefined;
    const pending = [...(state.pending ?? [])];
    const known = new Set(pending.map((p) => p.sha));
    // Oldest first, matching the order tasks were worked in.
    for (const { commit, refs } of attributeCommits(fresh, branchRef, base)) {
      if (known.has(commit.sha)) continue;
      if (refs.length === 0) continue;
      pending.push({ sha: commit.sha, subject: commit.subject, refs });
      known.add(commit.sha);
    }

    // With commits ahead of the upstream but no log to read, there is no way
    // to tell a published commit from a rewritten one — and both wrong answers
    // are damaging. Hold everything until a scan that can see the history.
    if (ahead !== undefined && ahead > 0 && commits.length === 0) {
      this.log.warn(`${repo.root.fsPath}: no git log available; holding ${pending.length} pending`);
      return;
    }

    const { published, unpublished, dropped } = partitionWithHeld(
      pending,
      commits,
      ahead,
    );
    for (const gone of dropped) {
      // An amend or a rebase replaced this commit. Its successor arrives as a
      // fresh commit in its own right, so forgetting this one loses nothing —
      // but doing it silently would make an unexplained missing close.
      this.log.info(
        `${gone.refs.join(", ")} dropped: ${gone.sha.slice(0, 8)} is no longer in the history`,
      );
    }
    const held = published.length > 0 ? await this.closePublished(projectId, published) : [];

    // Held commits stay pending (oldest first) so the next scan retries them.
    const kept = [...held, ...unpublished].slice(-PENDING_CAP);
    this.state[key] = {
      lastScannedHeadSha: repo.headSha,
      lastAhead: aheadKey,
      seenShas:
        commits.length > 0
          ? [...commits.map((c) => c.sha), ...state.seenShas].slice(0, SEEN_RING)
          : state.seenShas,
      pending: kept,
    };
    await this.cache.write(CACHE_FILES.gitState, this.state);
    // The tree's "commit not pushed" marker is for unpublished commits only.
    this.republishPending(projectId, kept.filter((p) => !p.held));
  }

  /** The branch's own task ref, or null when it must not be used: a detached
   *  HEAD, a branch with no ref in its name, or the project's default branch,
   *  where a long-lived shared branch would otherwise attribute every commit
   *  anyone makes to one task. */
  private branchRefFor(repo: RepoRef, projectId: string): string | null {
    const name = repo.head?.name;
    if (!name) return null;
    const declared = this.defaultBranchFor(projectId);
    if (declared ? name === declared : ASSUMED_DEFAULT_BRANCHES.has(name)) return null;
    return taskRefFromBranch(name);
  }

  /** Where HEAD's branch left the default branch: the merge-base with the
   *  remote-tracking default, else the local one. Undefined when neither
   *  resolves or the Git API cannot answer, which keeps the old attribution. */
  private async branchPoint(repo: RepoRef, projectId: string): Promise<string | undefined> {
    const head = repo.head?.name;
    if (!head) return undefined;
    for (const ref of mergeBaseCandidates(this.defaultBranchFor(projectId), repo.head?.upstream)) {
      const base = await this.git.mergeBase(repo.root, head, ref);
      if (base) return base;
    }
    this.logOnce(
      `${repo.root.toString()}:no-merge-base`,
      `${repo.root.fsPath}: no merge-base with the default branch; ` +
        `attributing every new commit on ${head} to its task`,
    );
    return undefined;
  }

  private republishPending(projectId: string, pending: PendingCommit[]): void {
    const refs = new Set<string>();
    for (const entry of pending) for (const ref of entry.refs) refs.add(ref);
    const before = this.pendingByProject.get(projectId);
    if (before && before.size === refs.size && [...refs].every((r) => before.has(r))) {
      return;
    }
    this.pendingByProject.set(projectId, refs);
    this.pendingEmitter.fire();
  }

  /** Close the tasks these published commits name. Returns the commits to try
   *  again: all of them while the task list has not loaded yet, and any whose
   *  write was not accepted because there is no session. Forgetting them
   *  instead would lose the close permanently, since the scan only runs again
   *  when git changes. */
  private async closePublished(
    projectId: string,
    entries: PendingCommit[],
  ): Promise<PendingCommit[]> {
    // `refreshedAt` is 0 until this session has fetched the list; a cached
    // list from the last session may be stale (a task assigned since), so its
    // being non-empty proves nothing.
    if (this.store.refreshedAt === 0) {
      this.log.info(`task list not loaded yet; holding ${entries.length} published commit(s)`);
      return entries.map((e) => ({ ...e, held: true }));
    }
    const tasks = this.store.forProject(projectId);
    const held = new Map<string, PendingCommit>();

    // Numeric normalisation makes T012 and T12 the same ref. If a project
    // genuinely contains both as distinct tasks, neither can be auto-closed —
    // guessing which one the developer meant is worse than doing nothing.
    const collisions = collidingRefs(tasks.map((t) => t.task.feature_tag));
    const byRef = new Map<string, AssignedTask>();
    for (const entry of tasks) {
      const ref = taskRefFromFeatureTag(entry.task.feature_tag);
      if (ref && !collisions.has(ref)) byRef.set(ref, entry);
    }

    for (const commit of entries) {
      for (const ref of commit.refs) {
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

        const written = await this.writer.setStatus({
          projectId,
          taskId: entry.task.id,
          // A published commit is evidence of implementation, not of
          // verification.
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
        if (written) {
          this.log.info(`closed ${ref} from ${commit.sha.slice(0, 8)}`);
        } else if (!this.isSignedIn()) {
          this.log.warn(
            `${ref} from ${commit.sha.slice(0, 8)} not closed: not signed in; will retry after sign-in`,
          );
          held.set(commit.sha, { ...commit, held: true });
        }
        // Otherwise the cloud refused it (the writer has logged why); retrying
        // an answer that will not change would only repeat it.
      }
    }
    return [...held.values()];
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
    this.pendingEmitter.dispose();
  }
}

const EMPTY_REFS: ReadonlySet<string> = new Set();
