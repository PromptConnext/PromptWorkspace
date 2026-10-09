// Start Task owns the task branch (finding #38).
//
// It used to try `createBranch` and, when the name was taken, give up and offer
// to prefill the commit message instead — so a second Start on the same task,
// or a branch the developer had made by hand, left HEAD on whatever branch it
// was on and the next `T14:` commit landed on another task's branch. Now an
// existing branch is checked out. No `vscode` import: the git calls are the
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
  if (await git.createBranch(root, branch)) return "created";
  // Refused, most often because the name exists. Checking it out is exactly
  // what the developer asked for; if git refuses that too (local changes that
  // would be overwritten, an unborn HEAD), say so rather than pretend.
  return (await git.checkout(root, branch)) ? "checked_out" : "failed";
}
