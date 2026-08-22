// The front half of the loop (ADR 0022 decision 4).
//
// Everything here exists to get one string — the task ref — into git, because
// that ref is the entire auto-close convention and until now the only way it
// got there was a developer reading it off a tree item and retyping it.
//
// Two carriers, offered together in one prompt rather than two: the branch
// name, which survives every commit made on it including the ones made in a
// terminal, and the Source Control commit box, which covers the developer who
// declines the branch. Both are declinable, because a developer already on a
// shared branch must not be forced into a branch creation to record that they
// have started work. Neither is persisted anywhere — if the developer takes
// neither, this extension does not guess, and says so.

import * as vscode from "vscode";
import { CloudHttpError } from "../cloud/errors.ts";
import type { AssignedTask } from "../cloud/types.ts";
import type { GitBridge } from "../git/gitBridge.ts";
import { branchNameForTask, taskRefFromFeatureTag } from "../git/taskRefs.ts";
import type { ProjectLink } from "../link/projectLink.ts";
import type { OutputLogger } from "../util/log.ts";
import type { StatusWriter } from "./statusWriter.ts";

export interface StartTaskDeps {
  assign: (projectId: string, taskId: string, userId: string) => Promise<unknown>;
  writer: StatusWriter;
  git: GitBridge;
  link: ProjectLink;
  currentUserId: () => string | undefined;
  log: OutputLogger;
}

type GitChoice = "branch" | "message" | "neither";

export async function startTask(
  entry: AssignedTask,
  deps: StartTaskDeps,
): Promise<void> {
  const { task, project_id: projectId } = entry;

  if (!(await claim(entry, deps))) return;

  if (task.status === "todo") {
    await deps.writer.setStatus({ projectId, taskId: task.id, status: "in_progress" });
  }

  const ref = taskRefFromFeatureTag(task.feature_tag);
  if (!ref) {
    // Nothing to carry. Claiming and starting still worked, so this is a
    // notice rather than a failure — but it has to be said, or the developer
    // will expect an auto-close that can never happen.
    void vscode.window.showInformationMessage(
      `Started "${task.title}". It has no task number, so commits cannot close it automatically.`,
    );
    return;
  }

  const root = repoRootFor(projectId, deps);
  if (!root) {
    void vscode.window.showInformationMessage(
      `Started ${ref}. No git repository is linked to this project, so there is ` +
        "nowhere to put the task number yet.",
    );
    return;
  }

  const branch = branchNameForTask(ref, task.title);
  const message = `${ref}: ${task.title}`;
  const choice = await askGitChoice(ref, branch);
  if (choice === "neither") return;

  if (choice === "branch") {
    const created = await deps.git.createBranch(root, branch);
    if (!created) {
      const retry = await vscode.window.showWarningMessage(
        `Could not create "${branch}" — the name may already be taken. ` +
          "Prefill the commit message instead?",
        "Prefill Message",
        "Cancel",
      );
      if (retry !== "Prefill Message") return;
    }
  }

  deps.git.setCommitMessage(root, message);
  deps.log.info(`started ${ref} (${choice})`);
}

/**
 * Take the task, or confirm it is already ours.
 *
 * Returns false when the caller must stop: someone else holds it, or the
 * cloud refused. ADR 0018 owns the endpoint; this adds no permission rules of
 * its own, so a refusal is reported exactly as the cloud phrased it.
 */
async function claim(entry: AssignedTask, deps: StartTaskDeps): Promise<boolean> {
  const me = deps.currentUserId();
  if (!me) {
    void vscode.window.showWarningMessage("Sign in to PromptConnext first.");
    return false;
  }

  const holder = entry.task.assigned_user_id;
  if (holder === me) return true;
  if (holder) {
    const choice = await vscode.window.showWarningMessage(
      `"${entry.task.title}" is assigned to someone else.`,
      "Take It Anyway",
      "Cancel",
    );
    if (choice !== "Take It Anyway") return false;
  }

  try {
    await deps.assign(entry.project_id, entry.task.id, me);
    return true;
  } catch (err) {
    const detail = err instanceof CloudHttpError ? err.message : String(err);
    deps.log.warn(`claim refused: ${detail}`);
    void vscode.window.showWarningMessage(
      `PromptConnext would not assign that task: ${detail}`,
    );
    return false;
  }
}

/** One prompt, three answers. Two prompts for two carriers reads as nagging
 *  for a gesture that is supposed to remove friction. */
async function askGitChoice(ref: string, branch: string): Promise<GitChoice> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(git-branch) Create branch ${branch}`,
        detail: `Every commit on it counts toward ${ref}, however the message is worded.`,
        choice: "branch" as const,
      },
      {
        label: "$(edit) Prefill the commit message only",
        detail: `Stay on this branch and start the next message with "${ref}: ".`,
        choice: "message" as const,
      },
      {
        label: "$(circle-slash) Neither",
        detail: `Add ${ref} to a commit subject yourself when you are ready.`,
        choice: "neither" as const,
      },
    ],
    { title: `Start ${ref}`, placeHolder: "How should git carry the task number?" },
  );
  return picked?.choice ?? "neither";
}

/** The repository this project is linked to — found through the link table
 *  rather than the focused editor, so starting a task from the tree works
 *  whichever file happens to be open. */
function repoRootFor(projectId: string, deps: StartTaskDeps): vscode.Uri | undefined {
  for (const repo of deps.git.repositories()) {
    if (deps.link.projectIdForRepoRoot(repo.root) === projectId) return repo.root;
  }
  return undefined;
}
