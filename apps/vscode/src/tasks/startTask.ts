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
import { CloudHttpError } from "@promptworkspace/cloud-client";
import type { AssignedTask } from "@promptworkspace/cloud-client";
import type { GitBridge } from "../git/gitBridge.ts";
import { branchNameForTask, taskRefFromFeatureTag } from "@promptworkspace/cloud-client";
import type { ProjectLink } from "../link/projectLink.ts";
import type { OutputLogger } from "../util/log.ts";
import type { StatusWriter } from "./statusWriter.ts";
import { ensureTaskBranch } from "./taskBranch.ts";
import {
  COPY_CONTEXT_ACTION,
  OPEN_IN_WEB_ACTION,
  noRepositoryNotice,
  noTaskNumberNotice,
  startNotice,
  type StartChoice,
} from "./startNotice.ts";

export interface StartTaskDeps {
  assign: (projectId: string, taskId: string, userId: string) => Promise<unknown>;
  writer: StatusWriter;
  git: GitBridge;
  link: ProjectLink;
  currentUserId: () => string | undefined;
  log: OutputLogger;
}

type GitChoice = StartChoice;

export async function startTask(
  entry: AssignedTask,
  deps: StartTaskDeps,
): Promise<void> {
  const { task, project_id: projectId } = entry;

  // Ask before anything is written: Escape at the picker must leave the task
  // exactly as it was (unclaimed, status untouched). With no task number or no
  // linked repository there is nothing to ask about, so those go straight on.
  const ref = taskRefFromFeatureTag(task.feature_tag);
  const root = ref ? repoRootFor(projectId, deps) : undefined;
  const branch = ref ? branchNameForTask(ref, task.title) : undefined;
  let choice: GitChoice | undefined;
  if (ref && root && branch) {
    choice = await askGitChoice(ref, branch);
    if (!choice) return;
  }

  if (!(await claim(entry, deps))) return;

  if (task.status === "todo") {
    await deps.writer.setStatus({ projectId, taskId: task.id, status: "in_progress" });
  }

  // These two replace the next-step notification (one notification per start):
  // without a ref or a repository there is no branch to name, and what the
  // developer most needs to hear is why commits will not close the task. Both
  // still offer the agent hand-off.
  if (!ref) {
    showStartNotice(noTaskNumberNotice(task.title), entry);
    return;
  }
  if (!root || !branch || !choice) {
    showStartNotice(noRepositoryNotice(ref), entry);
    return;
  }

  const message = `${ref}: ${task.title}`;
  let reported: GitChoice = choice;
  let noticeBranch: string | undefined = currentBranch(root, deps);

  if (choice === "branch") {
    // Create and check out, or check out the branch that already exists:
    // either way HEAD ends on the task's branch (finding #38).
    const result = await ensureTaskBranch(deps.git, root, branch);
    if (result === "failed") {
      const retry = await vscode.window.showWarningMessage(
        `Could not create or check out "${branch}" (local changes may be in the way; ` +
          "see the PromptWorkspace log). Prefill the commit message instead?",
        "Prefill Message",
        "Cancel",
      );
      reported = retry === "Prefill Message" ? "message" : "neither";
    } else {
      noticeBranch = branch;
    }
  }

  if (reported !== "neither") deps.git.setCommitMessage(root, message);
  deps.log.info(`started ${ref} (${choice})`);

  showStartNotice(startNotice(ref, reported, noticeBranch), entry);
}

/** The one notification a start ends with: the message plus the two agent
 *  hand-off actions, wired to the commands the task tree uses. */
function showStartNotice(message: string, entry: AssignedTask): void {
  void vscode.window
    .showInformationMessage(message, COPY_CONTEXT_ACTION, OPEN_IN_WEB_ACTION)
    .then((picked) => {
      const command = commandForAction(picked);
      // The same node shape the task tree passes to these commands.
      if (command) return vscode.commands.executeCommand(command, { kind: "task", entry });
    });
}

function commandForAction(picked: string | undefined): string | undefined {
  if (picked === COPY_CONTEXT_ACTION) return "promptworkspace.copyTaskContext";
  if (picked === OPEN_IN_WEB_ACTION) return "promptworkspace.openTaskInWeb";
  return undefined;
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
    void vscode.window.showWarningMessage("Sign in to PromptWorkspace first.");
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
      `PromptWorkspace would not assign that task: ${detail}`,
    );
    return false;
  }
}

/** One prompt, three answers. Two prompts for two carriers reads as nagging
 *  for a gesture that is supposed to remove friction. */
async function askGitChoice(ref: string, branch: string): Promise<GitChoice | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(git-branch) Work on branch ${branch}`,
        detail:
          `Created and checked out (or checked out, if it exists). Every commit on it ` +
          `counts toward ${ref}, however the message is worded.`,
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
  // Escape is a cancel, not "neither": the caller must not claim the task.
  return picked?.choice;
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

function currentBranch(root: vscode.Uri, deps: StartTaskDeps): string | undefined {
  return deps.git.repositoryFor(root)?.head?.name;
}
