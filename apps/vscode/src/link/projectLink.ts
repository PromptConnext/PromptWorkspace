// Which cloud project does this folder belong to?
//
// Answer: a resource-scoped `promptconnext.projectId` setting, discovered by
// matching git remotes and written only after the user confirms.
//
// Rejected, so they are not re-proposed:
//   * A `.promptconnext` dotfile — a second config system to teach, a gitignore
//     decision to make, duplicating a mechanism VS Code users already know.
//   * Pure remote matching with nothing persisted — breaks for forks, for a
//     monorepo holding several cloud projects, and for any remote that is an
//     SSH-config alias rather than a real host.
//   * workspaceState — invisible, unshareable, and lost when a user clears
//     editor state. The id is not a secret; a team should be able to commit it.

import * as vscode from "vscode";
import { projectIdFor, setProjectId } from "../config.ts";
import type { AssignedTask } from "../cloud/types.ts";
import type { GitBridge } from "../git/gitBridge.ts";
import { isCloneableRepoUrl, sameRepo } from "./repoUrl.ts";
import type { OutputLogger } from "../util/log.ts";

export interface ProjectCandidate {
  projectId: string;
  projectName: string;
  workspaceName: string;
  repoUrl?: string | null;
}

export class ProjectLink {
  private readonly promptedFolders = new Set<string>();

  private readonly git: GitBridge;
  private readonly log: OutputLogger;

  constructor(
    git: GitBridge,
    log: OutputLogger,
  ) {
    this.git = git;
    this.log = log;
  }

  /** The reverse lookup the git watcher needs. No link, no auto-close. */
  projectIdForRepoRoot(root: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(root);
    return projectIdFor(folder?.uri ?? root);
  }

  /** Candidates whose repo_url matches this folder's remotes. */
  candidatesFor(folder: vscode.Uri, tasks: AssignedTask[]): ProjectCandidate[] {
    const repo = this.git.repositoryFor(folder);
    if (!repo) return [];
    const remotes = repo.remotes
      .map((r) => r.fetchUrl ?? r.pushUrl)
      .filter((u): u is string => Boolean(u));
    if (remotes.length === 0) return [];

    const seen = new Set<string>();
    const out: ProjectCandidate[] = [];
    for (const entry of tasks) {
      if (seen.has(entry.project_id)) continue;
      // Anything the cloud hands us goes through the clone guard before it is
      // normalised, compared or shown — a hostile repo_url must not reach git
      // or the UI.
      if (!entry.repo_url || !isCloneableRepoUrl(entry.repo_url)) continue;
      if (!remotes.some((remote) => sameRepo(remote, entry.repo_url))) continue;
      seen.add(entry.project_id);
      out.push({
        projectId: entry.project_id,
        projectName: entry.project_name,
        workspaceName: entry.workspace_name,
        repoUrl: entry.repo_url,
      });
    }
    return out;
  }

  /**
   * Offer to link any unlinked folder whose remote matches a project.
   *
   * Never writes without confirmation, and never asks twice per session for
   * the same folder — a notification the user dismissed is an answer.
   */
  async offerLinks(tasks: AssignedTask[]): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      if (projectIdFor(folder.uri) || this.promptedFolders.has(key)) continue;
      const candidates = this.candidatesFor(folder.uri, tasks);
      if (candidates.length === 0) continue;
      this.promptedFolders.add(key);

      if (candidates.length === 1) {
        const choice = await vscode.window.showInformationMessage(
          `Link "${folder.name}" to the PromptConnext project "${candidates[0].projectName}"?`,
          "Link",
          "Not now",
        );
        if (choice === "Link") await this.link(folder, candidates[0]);
        continue;
      }
      await this.pick(folder, candidates);
    }
  }

  /** The explicit command: pick from every project the user has tasks in. */
  async linkInteractively(tasks: AssignedTask[]): Promise<void> {
    const folder = await pickFolder();
    if (!folder) return;
    const seen = new Map<string, ProjectCandidate>();
    for (const entry of tasks) {
      if (seen.has(entry.project_id)) continue;
      seen.set(entry.project_id, {
        projectId: entry.project_id,
        projectName: entry.project_name,
        workspaceName: entry.workspace_name,
        repoUrl: entry.repo_url,
      });
    }
    if (seen.size === 0) {
      void vscode.window.showInformationMessage(
        "No PromptConnext projects to link — you have no assigned tasks.",
      );
      return;
    }
    await this.pick(folder, [...seen.values()]);
  }

  private async pick(
    folder: vscode.WorkspaceFolder,
    candidates: ProjectCandidate[],
  ): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      candidates.map((c) => ({
        label: c.projectName,
        description: c.workspaceName,
        detail: c.repoUrl ?? undefined,
        candidate: c,
      })),
      { title: `Link "${folder.name}" to a PromptConnext project` },
    );
    if (picked) await this.link(folder, picked.candidate);
  }

  private async link(
    folder: vscode.WorkspaceFolder,
    candidate: ProjectCandidate,
  ): Promise<void> {
    await setProjectId(folder, candidate.projectId);
    this.log.info(`linked ${folder.name} -> ${candidate.projectId}`);
    void vscode.window.showInformationMessage(
      `Linked "${folder.name}" to ${candidate.projectName}.`,
    );
  }
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Open a folder first.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, folder: f })),
    { title: "Which folder?" },
  );
  return picked?.folder;
}
