// Has this commit reached the remote?
//
// ADR 0022's decision 1: a commit is evidence of implementation only once the
// team can fetch it. Between `git commit` and `git push` the task holds a
// local pending marker and nothing at all is written to the cloud.
//
// The signal is `Branch.ahead` from the vendored Git API — the number of
// commits on this branch that the upstream does not have. The commit log is
// newest-first, so those are the newest `ahead` entries and everything after
// them is published. Two properties make this cheap enough to prefer over
// shelling out to `git merge-base` (which ADR 0019 would make us spawn a
// process for):
//
//   * `ahead === 0` — the developer just pushed — is exact whatever shape the
//     history has, and that is the case the whole feature exists to serve.
//   * A pending sha the log no longer contains was rewritten away, by an
//     amend or a rebase, and is dropped rather than closed. Reading "absent
//     from the page" as "published" instead would close a task from a commit
//     the developer had just replaced, which is the precise mistake this
//     whole module exists to prevent.
//
// The inexact case is a branch with merge commits AND a non-zero ahead count,
// where log ordering and ancestry can disagree by an entry or two. The cost is
// bounded: the cloud's artifact write is idempotent on (task_id, commit_sha)
// and the status transition is one-way, so a close lands one scan early or
// late and never twice.

/** Anything with a sha. Generic so the watcher's richer entry survives the
 *  partition without this module knowing what else it carries. */
export interface HasSha {
  sha: string;
}

export interface Publication<T> {
  /** On the remote. Close the task. */
  published: T[];
  /** Committed locally and still ahead of the upstream. Keep waiting. */
  unpublished: T[];
  /** No longer in the history at all — amended or rebased away. Forget it;
   *  the replacement commit is discovered as a fresh one in its own right. */
  dropped: T[];
}

/**
 * Split pending commits into those the remote has, those it does not, and
 * those that no longer exist.
 *
 * `ahead` is `undefined` when the branch has no upstream — there is no
 * publication signal to read, so everything counts as published and the caller
 * falls back to closing at commit time (ADR 0022 decision 3). Callers must say
 * so in the log once per repository; silently changing when tasks close is the
 * failure this whole module is built to avoid.
 *
 * `ahead === 0` needs no log at all: nothing on this branch is missing from
 * the upstream, so callers may pass an empty `commits` rather than paying for
 * a read they cannot learn anything from.
 */
export function partitionByPublication<T extends HasSha>(
  pending: readonly T[],
  commits: readonly HasSha[],
  ahead: number | undefined,
): Publication<T> {
  if (ahead === undefined || ahead <= 0) {
    return { published: [...pending], unpublished: [], dropped: [] };
  }
  const positions = new Map(commits.map((c, i) => [c.sha, i]));
  const published: T[] = [];
  const unpublished: T[] = [];
  const dropped: T[] = [];
  for (const entry of pending) {
    const at = positions.get(entry.sha);
    if (at === undefined) dropped.push(entry);
    else if (at < ahead) unpublished.push(entry);
    else published.push(entry);
  }
  return { published, unpublished, dropped };
}

/**
 * `partitionByPublication`, for pending entries that may be `held`: a held
 * entry was already published when it was last looked at and only its close
 * failed to land (no session, task list not loaded). It is published by
 * definition, so it skips the log lookup — it may long since have fallen off
 * the page, and reading that as "rewritten away" would lose the close.
 */
export function partitionWithHeld<T extends HasSha & { held?: boolean }>(
  pending: readonly T[],
  commits: readonly HasSha[],
  ahead: number | undefined,
): Publication<T> {
  const held = pending.filter((p) => p.held);
  const rest = partitionByPublication(
    pending.filter((p) => !p.held),
    commits,
    ahead,
  );
  return { ...rest, published: [...held, ...rest.published] };
}

/** The upstream-aware ahead count, or undefined when nothing is tracked.
 *  A branch with no `upstream` reports whatever `ahead` the Git extension
 *  last happened to compute, which is not a publication signal — reading it
 *  as one would leave every un-tracked branch permanently "pending". */
export function aheadOf(
  head: { upstream?: string; ahead?: number } | undefined,
): number | undefined {
  if (!head?.upstream) return undefined;
  return head.ahead ?? 0;
}
