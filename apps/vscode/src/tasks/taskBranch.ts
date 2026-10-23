// Start Task owns the task branch (finding #38).
//
// It used to try `createBranch` and, when the name was taken, give up and offer
// to prefill the commit message instead — so a second Start on the same task,
// or a branch the developer had made by hand, left HEAD on whatever branch it
// was on and the next `T14:` commit landed on another task's branch. Now an
// existing branch (local, or only on the remote) is checked out, and only a
// branch that exists nowhere is created. A remote-only branch must have been
// fetched: git can only track a branch it knows about. No `vscode` import: the git calls are the
// three `GitBridge` methods, injected.

export type TaskBranchResult = "created" | "checked_out" | "failed";

/** Where a branch name exists as a ref: a local branch, a remote-tracking
 *  branch only, nowhere, or `unknown` when the refs could not be read. */
export type BranchLocation = "local" | "remote" | "none" | "unknown";

export interface BranchOps<Root> {
  findBranch(root: Root, name: string): Promise<BranchLocation>;
  createBranch(root: Root, name: string): Promise<boolean>;
  checkout(root: Root, name: string): Promise<boolean>;
}

export async function ensureTaskBranch<Root>(
  git: BranchOps<Root>,
  root: Root,
  branch: string,
): Promise<TaskBranchResult> {
  const where = await git.findBranch(root, branch);
  // `git checkout <name>` is only safe for a name that is a ref: with no such
  // ref, git reads it as a pathspec and silently discards local changes to a
  // same-named file. So check out only what is known to exist — a local
  // branch, or a remote-only one, for which git's DWIM creates the tracking
  // branch (creating first would cut an unrelated branch from HEAD).
  if (where === "local" || where === "remote") {
    return (await git.checkout(root, branch)) ? "checked_out" : "failed";
  }
  if (await git.createBranch(root, branch)) return "created";
  // Refs unreadable (an older Git API): a refused create most likely means
  // the name is taken by a local branch, and checking that out is safe.
  if (where === "unknown") {
    return (await git.checkout(root, branch)) ? "checked_out" : "failed";
  }
  // Refused for some other reason (local changes in the way, an unborn
  // HEAD): say so rather than pretend.
  return "failed";
}
