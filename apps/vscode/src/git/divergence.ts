// Where does a task branch begin? (Finding #41.)
//
// A branch named `T1-…` attributes its commits to T1 even when their subjects
// name no task (ADR 0022's branch fallback). The first scan on such a branch
// used to apply that to every commit in the log, including the history the
// branch inherited from the default branch, so T1 closed from the repository's
// import commit. Branch attribution now covers only the commits after the
// merge-base with the default branch. A subject ref is still honoured on any
// commit: it names its task explicitly.
//
// Pure, so it is unit-tested; gitWatcher.ts supplies the log and the
// merge-base (via the Git API's `getMergeBase`, which may be missing in a fork
// — then `baseSha` is undefined and the old behaviour stands).

import { refsForCommit } from "@promptworkspace/cloud-client";

interface LogEntry {
  sha: string;
  subject: string;
}

/**
 * The commits in `log` (newest first) that come after `baseSha`. A base that
 * is not on the page is older than the whole page — a merge-base is always an
 * ancestor of HEAD — so then every entry counts.
 */
export function commitsSinceDivergence<T extends { sha: string }>(
  log: readonly T[],
  baseSha: string,
): T[] {
  const at = log.findIndex((commit) => commit.sha === baseSha);
  return at < 0 ? [...log] : log.slice(0, at);
}

/**
 * The task refs of each commit, oldest first (the order tasks were worked in).
 * `branchRef` applies only to commits after `baseSha`; with no `baseSha` it
 * applies to all of them, which is the behaviour before this fix.
 */
export function attributeCommits<T extends LogEntry>(
  log: readonly T[],
  branchRef: string | null,
  baseSha: string | undefined,
): { commit: T; refs: string[] }[] {
  const onBranch =
    branchRef && baseSha !== undefined
      ? new Set(commitsSinceDivergence(log, baseSha).map((commit) => commit.sha))
      : null;
  return [...log].reverse().map((commit) => ({
    commit,
    refs: refsForCommit(commit.subject, onBranch && !onBranch.has(commit.sha) ? null : branchRef),
  }));
}

/**
 * Refs to take the merge-base against, best first: `origin`'s default branch,
 * then the upstream remote's (when that is not `origin`), then the local one.
 * `origin` first because the upstream may be a fork whose `main` is weeks
 * stale, which would put the branch point back in old history (#41 again);
 * a local `main` can be stale too, so it comes last. With no declared default
 * the usual names are tried, as `gitWatcher.ts` assumes.
 */
export function mergeBaseCandidates(
  defaultBranch: string | null,
  upstream: string | undefined,
): string[] {
  const slash = upstream ? upstream.indexOf("/") : -1;
  const upstreamRemote = upstream && slash > 0 ? upstream.slice(0, slash) : undefined;
  const remotes =
    upstreamRemote && upstreamRemote !== "origin" ? ["origin", upstreamRemote] : ["origin"];
  const names = defaultBranch ? [defaultBranch] : ["main", "master"];
  return names.flatMap((name) => [...remotes.map((remote) => `${remote}/${name}`), name]);
}
