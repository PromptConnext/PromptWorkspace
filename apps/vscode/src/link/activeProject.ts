// Which project am I in?
//
// Asked by both the task tree and the context webview, and answered here once
// so the two cannot disagree — a sidebar showing project A's tasks above
// project B's coding rules is worse than either being empty.
//
// The answer follows the editor rather than any stored selection. That is the
// whole design: a stored "active project" can drift out of step with the folder
// you are typing in, and there is no way for the user to notice until it has
// misled them. Switching projects is opening a file in the other folder, which
// is a gesture VS Code already owns.

import * as vscode from "vscode";
import { projectIdFor } from "../config.ts";

export interface ActiveProject {
  projectId: string;
  folder: vscode.WorkspaceFolder;
}

export function activeProject(): ActiveProject | undefined {
  const open = vscode.window.activeTextEditor?.document.uri;
  if (open) {
    const folder = vscode.workspace.getWorkspaceFolder(open);
    const projectId = folder ? projectIdFor(folder.uri) : undefined;
    if (folder && projectId) return { projectId, folder };
  }
  // No editor, or an editor outside any linked folder (an output pane, a file
  // opened from disk): fall back to the first linked folder, which in a
  // single-root window is the only one there is.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const projectId = projectIdFor(folder.uri);
    if (projectId) return { projectId, folder };
  }
  return undefined;
}
