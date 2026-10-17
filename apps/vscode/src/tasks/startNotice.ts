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

const HAND_OFF = "You can still hand it to your AI agent: copy the task context.";

/** Start Task on a task whose feature tag carries no task number. */
export function noTaskNumberNotice(title: string): string {
  return `Started "${title}". It has no task number, so commits cannot close it automatically. ${HAND_OFF}`;
}

/** Start Task when no git repository is linked to the project. */
export function noRepositoryNotice(featureTag: string): string {
  return (
    `Started ${featureTag}. No git repository is linked to this project, so there is ` +
    `nowhere to put the task number yet. ${HAND_OFF}`
  );
}
