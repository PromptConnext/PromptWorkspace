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
import type { AssignedTask } from "@promptworkspace/cloud-client";
import { TASK_STATUS_LABELS, isClosed } from "@promptworkspace/cloud-client";
import { taskRefFromFeatureTag } from "@promptworkspace/cloud-client";
import type { ActiveProject } from "../link/activeProject.ts";
import type { TaskStore } from "./taskStore.ts";
import { escapeMarkdown } from "../util/markdown.ts";
import { bannerTreeItem } from "../auth/banner.ts";
import { withBanner, type BannerRow, type Connection } from "../auth/status.ts";

export class TaskNode {
  readonly kind = "task";
  readonly entry: AssignedTask;

  constructor(entry: AssignedTask) {
    this.entry = entry;
  }
}

export type TreeNode = TaskNode | BannerRow;

export class TaskTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly store: TaskStore;
  private readonly active: () => ActiveProject | undefined;
  private readonly pendingRefs: (projectId: string) => ReadonlySet<string>;
  private readonly connection: () => Connection;

  constructor(
    store: TaskStore,
    active: () => ActiveProject | undefined,
    // ADR 0022: between commit and push nothing is written to the cloud, so
    // this decoration is the only signal a developer gets that their task
    // number parsed. Injected rather than read, so the tree keeps no state
    // that could disagree with the watcher's.
    pendingRefs: (projectId: string) => ReadonlySet<string>,
    // Signed out / unlinked (findings #37, #42): a banner row above the tasks.
    connection: () => Connection,
  ) {
    this.store = store;
    this.active = active;
    this.pendingRefs = pendingRefs;
    this.connection = connection;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "banner") return bannerTreeItem(node);
    const { task } = node.entry;
    const item = new vscode.TreeItem(task.title, vscode.TreeItemCollapsibleState.None);
    item.id = `task:${task.id}`;
    const ref = taskRefFromFeatureTag(task.feature_tag);
    const pending =
      ref !== null && this.pendingRefs(node.entry.project_id).has(ref);
    item.description = [
      task.feature_tag,
      TASK_STATUS_LABELS[task.status],
      pending ? "commit not pushed" : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    if (pending) item.iconPath = new vscode.ThemeIcon("cloud-upload");
    item.contextValue = "promptworkspace.task";
    item.checkboxState = isClosed(task.status)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    item.tooltip = this.tooltip(node.entry);
    // A row click used to copy the context with only a toast to show for it,
    // and Start Task was a hover-only icon (finding #36). It now asks.
    item.command = {
      command: "promptworkspace.taskActions",
      title: "Task Actions",
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return [];
    const current = this.active();
    if (!current) return [];
    const tasks = this.store.forProject(current.projectId).map((entry) => new TaskNode(entry));
    return withBanner(this.connection(), tasks);
  }

  private tooltip(entry: AssignedTask): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    // task title, project name, workspace name and acceptance-criterion text
    // are all cloud-supplied; escaped so e.g. `![](https://tracker/x.png)` in
    // a title cannot render as a loaded image inside a hover tooltip.
    md.appendMarkdown(`**${escapeMarkdown(entry.task.title)}**\n\n`);
    md.appendMarkdown(
      `${escapeMarkdown(entry.project_name)} · ${escapeMarkdown(entry.workspace_name)}\n\n`,
    );
    md.appendMarkdown(`Status: ${TASK_STATUS_LABELS[entry.task.status]}\n\n`);
    // `criterion.text` — the shape apps/cloud stores and warns against
    // flattening. Read the field; never assume a bare string.
    if (entry.task.acceptance_criteria.length > 0) {
      md.appendMarkdown("Acceptance criteria:\n");
      for (const criterion of entry.task.acceptance_criteria) {
        md.appendMarkdown(`- ${escapeMarkdown(criterion.text)}\n`);
      }
    }
    return md;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
