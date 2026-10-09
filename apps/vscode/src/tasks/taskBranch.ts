// Start Task owns the task branch (finding #38).
//
// It used to try `createBranch` and, when the name was taken, give up and offer
// to prefill the commit message instead — so a second Start on the same task,
// or a branch the developer had made by hand, left HEAD on whatever branch it
// was on and the next `T14:` commit landed on another task's branch. Now an
// existing branch (local, or only on the remote) is checked out, and only a
// branch that exists nowhere is created. No `vscode` import: the git calls are the
// two `GitBridge` methods, injected.

export type TaskBranchResult = "created" | "checked_out" | "failed";

export interface BranchOps<Root> {
  createBranch(root: Root, name: string): Promise<boolean>;
  checkout(root: Root, name: string): Promise<boolean>;
}

export async function ensureTaskBranch<Root>(
  git: BranchOps<Root>,
  root: Root,
  branch: string,
): Promise<TaskBranchResult> {
  // Check out first: an existing local branch is switched to, and a branch
  // that exists only on the remote (a teammate pushed it, or this developer
  // on another machine) gets git's tracking branch from it. Creating first
  // would cut a new, unrelated local branch from HEAD in that second case.
  if (await git.checkout(root, branch)) return "checked_out";
  // No such branch anywhere: create it. If git refuses that too (local
  // changes that would be overwritten, an unborn HEAD), say so rather than
  // pretend.
  return (await git.createBranch(root, branch)) ? "created" : "failed";
}
