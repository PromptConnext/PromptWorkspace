// The task tree: the active project's tasks, with a checkbox per task.
//
// It used to group by project, because it rendered every assigned task across
// every project. It no longer does: the tree is scoped to the project the
// editor is in, so a project node would be a permanent single-child parent —
// a click to open something that is already open. The project's identity moved
// to the view description, where it is visible without expanding anything.
//
// TreeItem.checkboxState is stable since VS Code 1.80 and is the natural
// affordance for "done", which is why engines.vscode floors at 1.85.

import * as vscode from "vscode";
import type { AssignedTask } from "../cloud/types.ts";
import { TASK_STATUS_LABELS, isClosed } from "../cloud/types.ts";
import type { ActiveProject } from "../link/activeProject.ts";
import type { TaskStore } from "./taskStore.ts";

export class TaskNode {
  readonly kind = "task";
  readonly entry: AssignedTask;

  constructor(entry: AssignedTask) {
    this.entry = entry;
  }
}

export type TreeNode = TaskNode;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly store: TaskStore;
  private readonly active: () => ActiveProject | undefined;

  constructor(store: TaskStore, active: () => ActiveProject | undefined) {
    this.store = store;
    this.active = active;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
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
    if (node) return [];
    const current = this.active();
    if (!current) return [];
    return this.store.forProject(current.projectId).map((entry) => new TaskNode(entry));
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
