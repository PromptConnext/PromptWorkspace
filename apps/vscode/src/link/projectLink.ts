// Which cloud project does this folder belong to?
//
// Answer: a resource-scoped `promptconnext.projectId` setting, discovered by
// matching git remotes against the workspace roster, and written only after the
// user confirms — with one exception, `applyPendingClone`, where the user
// already confirmed by clicking Clone and a second prompt would be asking the
// same question twice.
//
// Candidates come from the roster rather than from assigned tasks, which is
// what lets a folder be linked to a project that has no work assigned to this
// developer yet.
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
import type { StorageLike } from "@promptconnext/pz-cloud";
import type { GitBridge } from "../git/gitBridge.ts";
import { pendingCloneMatches, PENDING_CLONE_TTL_MS, type PendingClone } from "../projects/roster.ts";
import { readPendingClone, rememberClone, writePendingClone } from "../projects/knownClones.ts";
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
  // Several repositories can open close together (git.clone discovery races
  // the extension's own bootstrap call), and `applyPendingClone` reads the
  // pending record before it clears it — so two overlapping invocations can
  // both read the same still-present record, both persist it, and both show
  // a "Linked …" notification. This flag makes the method itself the guard,
  // independent of gitBridge.ts's own dedup of the events that trigger it.
  private applying = false;

  private readonly git: GitBridge;
  private readonly log: OutputLogger;
  private readonly state: StorageLike;

  constructor(
    git: GitBridge,
    log: OutputLogger,
    state: StorageLike,
  ) {
    this.git = git;
    this.log = log;
    this.state = state;
  }

  /** The reverse lookup the git watcher needs. No link, no auto-close. */
  projectIdForRepoRoot(root: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(root);
    return projectIdFor(folder?.uri ?? root);
  }

  /** Candidates whose repo_url matches this folder's remotes. */
  candidatesFor(folder: vscode.Uri, candidates: ProjectCandidate[]): ProjectCandidate[] {
    const remotes = this.remotesFor(folder);
    if (remotes.length === 0) return [];
    return candidates.filter(
      (candidate) =>
        candidate.repoUrl != null &&
        isCloneableRepoUrl(candidate.repoUrl) &&
        remotes.some((remote) => sameRepo(remote, candidate.repoUrl)),
    );
  }

  private remotesFor(folder: vscode.Uri): string[] {
    const repo = this.git.repositoryFor(folder);
    if (!repo) return [];
    return repo.remotes
      .map((r) => r.fetchUrl ?? r.pushUrl)
      .filter((u): u is string => Boolean(u));
  }

  /**
   * Offer to link any unlinked folder whose remote matches a project.
   *
   * Never writes without confirmation, and never asks twice per session for
   * the same folder — a notification the user dismissed is an answer.
   */
  async offerLinks(candidates: ProjectCandidate[]): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = folder.uri.toString();
      if (projectIdFor(folder.uri) || this.promptedFolders.has(key)) continue;
      const matches = this.candidatesFor(folder.uri, candidates);
      if (matches.length === 0) continue;
      this.promptedFolders.add(key);

      if (matches.length === 1) {
        const choice = await vscode.window.showInformationMessage(
          `Link "${folder.name}" to the PromptConnext project "${matches[0].projectName}"?`,
          "Link",
          "Not now",
        );
        if (choice === "Link") await this.link(folder, matches[0]);
        continue;
      }
      await this.pick(folder, matches);
    }
  }

  /** The explicit command: pick from every project in the roster. */
  async linkInteractively(candidates: ProjectCandidate[]): Promise<void> {
    const folder = await pickFolder();
    if (!folder) return;
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        "No PromptConnext projects with a repository to link to.",
      );
      return;
    }
    await this.pick(folder, candidates);
  }

  /**
   * Link a folder this extension just cloned, without asking again.
   *
   * The prompt `offerLinks` shows is the right default for a folder we merely
   * recognise. It is the wrong one here: the user clicked Clone on a named
   * project seconds ago, and asking "is this that project?" invites the answer
   * "why are you asking?". The record expires so an abandoned clone cannot
   * make this silent write happen days later.
   *
   * Idempotent by construction, which matters because this is no longer a
   * one-shot call (see the caller in extension.ts): a folder that already has
   * a `projectId` is skipped, and the pending record is cleared the moment it
   * is consumed, so a second call with nothing left to do is just a Memento
   * read and a no-op loop.
   */
  async applyPendingClone(candidates: ProjectCandidate[]): Promise<void> {
    // Overlapping callers (gitBridge.ts's own dedup narrows this but cannot
    // eliminate it — see its comment) must not both read the pending record
    // before either clears it. A later call finding nothing to do here is a
    // Memento read and a no-op, which is cheap enough to make "just skip if
    // busy" the right trade rather than queuing.
    if (this.applying) return;
    this.applying = true;
    try {
      const pending: PendingClone | undefined = readPendingClone(this.state);
      if (!pending) return;
      const now = Date.now();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (projectIdFor(folder.uri)) continue;
        if (!pendingCloneMatches(pending, this.remotesFor(folder.uri), now)) continue;
        const candidate = candidates.find((c) => c.projectId === pending.projectId);
        await this.persist(folder, pending.projectId);
        await writePendingClone(this.state, undefined);
        const name = candidate?.projectName ?? "the project you cloned";
        this.log.info(`pending clone linked ${folder.name} -> ${pending.projectId}`);
        void vscode.window.showInformationMessage(`Linked "${folder.name}" to ${name}.`);
        return;
      }
      // Expired records are dropped on sight so they cannot fire later.
      if (now - pending.startedAt > PENDING_CLONE_TTL_MS) {
        await writePendingClone(this.state, undefined);
      }
    } finally {
      this.applying = false;
    }
  }

  /** Sign-out: a folder user A declined to link stays declined for user B in
   *  the same window session unless this runs. `promptedFolders` only ever
   *  grows otherwise, so without this a folder opened under a second account
   *  in the same session would silently never be offered again. */
  clearPromptedFolders(): void {
    this.promptedFolders.clear();
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
    await this.persist(folder, candidate.projectId);
    this.log.info(`linked ${folder.name} -> ${candidate.projectId}`);
    void vscode.window.showInformationMessage(
      `Linked "${folder.name}" to ${candidate.projectName}.`,
    );
  }

  /** The write both the confirmed path and the silent path share: set the
   *  setting, and remember the folder so a future window (or this one, after
   *  the git repository closes) can still tell the project is cloned here.
   *  Notification is deliberately not part of this helper — the two callers
   *  say different things, and one of them says nothing at all. */
  private async persist(folder: vscode.WorkspaceFolder, projectId: string): Promise<void> {
    await setProjectId(folder, projectId);
    await rememberClone(this.state, projectId, folder.uri.fsPath);
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
