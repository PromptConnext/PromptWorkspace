// The banner row both trees put first when this window is signed out or its
// folder is unlinked (see status.ts, which decides whether there is one).

import * as vscode from "vscode";
import type { BannerRow } from "./status.ts";

export function bannerTreeItem(row: BannerRow): vscode.TreeItem {
  const { connection } = row;
  const item = new vscode.TreeItem(connection.banner, vscode.TreeItemCollapsibleState.None);
  item.id = `banner:${connection.state}`;
  item.iconPath = new vscode.ThemeIcon("warning");
  item.tooltip = connection.message;
  item.contextValue = "promptworkspace.banner";
  if (connection.action) {
    item.command = { command: connection.action.command, title: connection.action.title };
  }
  return item;
}
