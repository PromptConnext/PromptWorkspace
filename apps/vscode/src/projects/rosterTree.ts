// The Projects view: workspaces over projects, with the local state of each
// project written into the row rather than hidden behind a click.
//
// Selecting a workspace is expanding it. That is the whole mechanism, and it is
// deliberate: a workspace picker implies a stored selection, and a stored
// selection can be stale, can survive a membership change, and can disagree
// with the folder the developer has open. A collapsible node holds no state.

import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { GitBridge } from "../git/gitBridge.ts";
import type { TaskStore } from "../tasks/taskStore.ts";
import { buildRoster, type ProjectRow, type WorkspaceRow } from "./roster.ts";
import { readKnownClones } from "./knownClones.ts";
import type { StorageLike } from "@promptworkspace/cloud-client";
import type { RosterStore } from "./rosterStore.ts";
import { escapeMarkdown } from "../util/markdown.ts";

export class WorkspaceTreeNode {
  readonly kind = "workspace";
  readonly row: WorkspaceRow;
  constructor(row: WorkspaceRow) {
    this.row = row;
  }
}

export class ProjectTreeNode {
  readonly kind = "project";
  readonly row: ProjectRow;
  constructor(row: ProjectRow) {
    this.row = row;
  }
}

export type RosterNode = WorkspaceTreeNode | ProjectTreeNode;

const STATE_ICON: Record<ProjectRow["localState"], string> = {
  local: "repo",
  "remote-only": "cloud-download",
  "no-repo": "circle-slash",
};

const STATE_TEXT: Record<ProjectRow["localState"], string> = {
  local: "cloned",
  "remote-only": "not cloned",
  "no-repo": "no repo yet",
};

export class RosterTreeProvider implements vscode.TreeDataProvider<RosterNode> {
  private readonly emitter = new vscode.EventEmitter<RosterNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly roster: RosterStore;
  private readonly tasks: TaskStore;
  private readonly git: GitBridge;
  private readonly state: StorageLike;

  constructor(roster: RosterStore, tasks: TaskStore, git: GitBridge, state: StorageLike) {
    this.roster = roster;
    this.tasks = tasks;
    this.git = git;
    this.state = state;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  /** Rebuilt on every read rather than memoised: the inputs are open git
   *  remotes and a task list that both change under us, and the cost is a sort
   *  over a handful of rows. */
  rows(): WorkspaceRow[] {
    const taskCounts: Record<string, number> = {};
    for (const entry of this.tasks.all()) {
      taskCounts[entry.project_id] = (taskCounts[entry.project_id] ?? 0) + 1;
    }
    return buildRoster({
      entries: this.roster.all(),
      openRepos: this.git.repositories().map((repo) => ({
        path: repo.root.fsPath,
        remotes: repo.remotes
          .map((r) => r.fetchUrl ?? r.pushUrl)
          .filter((u): u is string => Boolean(u)),
      })),
      knownClones: readKnownClones(this.state),
      taskCounts,
      // Sync existence check: the tree is built synchronously and this is a
      // stat on a path we wrote ourselves, not a directory walk. Imported at
      // the top of the file rather than `require`d here — esbuild's output
      // format is not something a call site should depend on.
      folderExists: (path) => {
        try {
          return existsSync(path);
        } catch {
          return false;
        }
      },
    });
  }

  getTreeItem(node: RosterNode): vscode.TreeItem {
    if (node.kind === "workspace") {
      const item = new vscode.TreeItem(
        node.row.workspaceName,
        // A workspace with work waiting should not need a click to reveal it,
        // and a lone workspace should never look like a folder to open.
        node.row.hasAssignedTasks
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `workspace:${node.row.workspaceId}`;
      item.contextValue = "promptworkspace.workspace";
      item.iconPath = new vscode.ThemeIcon("organization");
      return item;
    }

    const { row } = node;
    const item = new vscode.TreeItem(row.projectName, vscode.TreeItemCollapsibleState.None);
    item.id = `project:${row.projectId}`;
    const tasks =
      row.taskCount === 1 ? "1 task" : row.taskCount > 1 ? `${row.taskCount} tasks` : undefined;
    const lifecycle = row.localState === "no-repo" ? row.lifecycleStatus.replace(/_/g, " ") : undefined;
    item.description = [tasks, lifecycle, STATE_TEXT[row.localState]].filter(Boolean).join(" · ");
    item.iconPath = new vscode.ThemeIcon(STATE_ICON[row.localState]);
    // The context value IS the action: package.json binds Clone to
    // remote-only, Open to local, and web-only to no-repo, so a row can never
    // offer an action its state cannot honour.
    item.contextValue = `promptworkspace.project.${row.localState}`;
    item.tooltip = this.tooltip(row);
    return item;
  }

  getChildren(node?: RosterNode): RosterNode[] {
    if (!node) return this.rows().map((row) => new WorkspaceTreeNode(row));
    if (node.kind === "workspace") {
      return node.row.projects.map((row) => new ProjectTreeNode(row));
    }
    return [];
  }

  private tooltip(row: ProjectRow): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    // projectName and workspaceName are cloud-supplied; escaped so a name
    // like `[click](https://evil)` renders as literal text, not a live link.
    md.appendMarkdown(
      `**${escapeMarkdown(row.projectName)}**\n\n${escapeMarkdown(row.workspaceName)}\n\n`,
    );
    if (row.localPath) md.appendMarkdown(`Cloned to \`${row.localPath}\`\n\n`);
    // Rendered as code, never as a link: this string came from the cloud and
    // markdown link syntax in a name is not something to hand a click to.
    if (row.repoUrl) md.appendMarkdown(`\`${row.repoUrl}\`\n\n`);
    if (row.localState === "no-repo") {
      md.appendMarkdown("No repository yet — this project is still being planned.");
    }
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
