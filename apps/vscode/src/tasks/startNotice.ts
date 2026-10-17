// The one notification Start Task shows when it has succeeded (plan 0030,
// task 18). Kept free of `vscode` so the copy can be unit-tested.

export type StartChoice = "branch" | "message" | "neither";

export const COPY_CONTEXT_ACTION = "Copy Task Context";
export const OPEN_IN_WEB_ACTION = "Open in Web";

/**
 * `branch` is the task branch for the "branch" choice and the current branch
 * for the other two; undefined means there is no branch to name (no
 * repository, detached HEAD), which reads as "in this folder".
 */
export function startNotice(
  featureTag: string,
  choice: StartChoice,
  branch: string | undefined,
): string {
  const where = !branch
    ? "in this folder"
    : choice === "branch"
      ? `on branch ${branch}`
      : `on ${branch}`;
  return (
    `Started ${featureTag} ${where}. Next, hand it to your AI agent: copy the task ` +
    "context and paste it into Claude Code, Cursor or your agent of choice."
  );
}
