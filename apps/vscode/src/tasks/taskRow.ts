// The text beside a task in MY TASKS. Pure so it is testable without `vscode`.

import type { Task } from "@promptworkspace/cloud-client";
import { TASK_STATUS_LABELS } from "@promptworkspace/cloud-client";

export function taskDescription(
  task: Pick<Task, "feature_tag" | "status">,
  opts: { pending: boolean; onBranch: boolean },
): string {
  return [
    opts.onBranch ? "on this branch" : undefined,
    task.feature_tag,
    TASK_STATUS_LABELS[task.status],
    opts.pending ? "commit not pushed" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}
