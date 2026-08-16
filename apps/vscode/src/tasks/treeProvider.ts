// The task tree: project nodes over task nodes, with a checkbox per task.
//
// TreeItem.checkboxState is stable since VS Code 1.80 and is the natural
// affordance for "done" — which is why engines.vscode floors at 1.85 rather
// than something older.

import * as vscode from "vscode";
import type { AssignedTask } from "../cloud/types.ts";
import { TASK_STATUS_LABELS, isClosed } from "../cloud/types.ts";
import type { TaskStore } from "./taskStore.ts";

export class ProjectNode {
  readonly kind = "project";
  readonly projectId: string;
  readonly projectName: string;
  // Carried even though nothing renders it: the web app has no bare
  // /p/{projectId} route, so opening a project in the browser needs the
  // workspace that owns it (apps/web routes: /w/[workspaceId]/p/[projectId]).
  readonly workspaceId: string;
  readonly workspaceName: string;

  constructor(
    projectId: string,
    projectName: string,
    workspaceId: string,
    workspaceName: string,
  ) {
    this.projectId = projectId;
    this.projectName = projectName;
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
  }
}

export class TaskNode {
  readonly kind = "task";
  readonly entry: AssignedTask;

  constructor(entry: AssignedTask) {
    this.entry = entry;
  }
}

export type TreeNode = ProjectNode | TaskNode;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "project") {
      const item = new vscode.TreeItem(
        node.projectName,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = node.workspaceName;
      item.contextValue = "promptconnext.project";
      item.iconPath = new vscode.ThemeIcon("repo");
      return item;
    }

    const { task } = node.entry;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${task.id}`;
    item.description = [task.feature_tag, TASK_STATUS_LABELS[task.status]]
      .filter(Boolean)
      .join(" · ");
    item.contextValue = "promptconnext.task";
    item.checkboxState = isClosed(task.status)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = this.tooltip(node.entry);
    item.command = {
      command: "promptconnext.copyTaskContext",
      title: "Copy Task Context",
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const all = this.store.all();
    if (!node) {
      const seen = new Map<string, ProjectNode>();
      for (const entry of all) {
        if (!seen.has(entry.project_id)) {
          seen.set(
            entry.project_id,
            new ProjectNode(
              entry.project_id,
              entry.project_name,
              entry.workspace_id,
              entry.workspace_name,
            ),
          );
        }
      }
      return [...seen.values()];
    }
    if (node.kind === "project") {
      return this.store.forProject(node.projectId).map((e) => new TaskNode(e));
    }
    return [];
  }

  private tooltip(entry: AssignedTask): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${entry.task.title}**\n\n`);
    md.appendMarkdown(`${entry.project_name} · ${entry.workspace_name}\n\n`);
    md.appendMarkdown(`Status: ${TASK_STATUS_LABELS[entry.task.status]}\n\n`);
    // `criterion.text` — the shape apps/cloud stores and warns against
    // flattening. Read the field; never assume a bare string.
    if (entry.task.acceptance_criteria.length > 0) {
      md.appendMarkdown("Acceptance criteria:\n");
      for (const criterion of entry.task.acceptance_criteria) {
        md.appendMarkdown(`- ${criterion.text}\n`);
      }
    }
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
