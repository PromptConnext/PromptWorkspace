// Clone, delegated.
//
// `git.clone` is the Git extension's own command: it owns the folder picker,
// the progress notification, credential prompts, and the "open the result
// where?" question. Reimplementing any of that would be reimplementing it
// worse, and a `git` subprocess of ours would be the sidecar ADR 0019 removed.
//
// It is a CONTRIBUTED COMMAND, not published API — the same stability class as
// the vendored git.d.ts. So it is detected by asking for the command list and
// looking, never by `typeof`, and its absence degrades to the clipboard.

import * as vscode from "vscode";
import type { LoggerLike } from "../cloud/client.ts";
import type { StorageLike } from "../cloud/session.ts";
import { writePendingClone } from "./knownClones.ts";
import { safeRepoUrl, type ProjectRow } from "./roster.ts";

export async function cloneProject(
  row: ProjectRow,
  state: StorageLike,
  log: LoggerLike,
): Promise<void> {
  // Guarded a second time at the point of use. The row was built from a guarded
  // URL, but this is the call that reaches git, and that is where the check has
  // to be true rather than have been true earlier.
  const url = safeRepoUrl(row.repoUrl);
  if (!url) {
    void vscode.window.showErrorMessage(
      `${row.projectName} has no repository that can be cloned.`,
    );
    return;
  }

  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes("git.clone")) {
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showWarningMessage(
      `This editor has no Git clone command. The repository URL for ${row.projectName} was copied to the clipboard.`,
    );
    log.warn("git.clone is unavailable; fell back to the clipboard");
    return;
  }

  // Written BEFORE the command runs: `git.clone` usually opens the result in a
  // new window, and once it does, this window may never see the folder at all.
  await writePendingClone(state, {
    projectId: row.projectId,
    repoUrl: url,
    startedAt: Date.now(),
  });
  log.info(`cloning ${row.projectName} (${row.projectId})`);
  await vscode.commands.executeCommand("git.clone", url);
}
