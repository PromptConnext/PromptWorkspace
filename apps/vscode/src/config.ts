// Settings.
//
// The engine read all of this from process.env (apps/engine/src/config.ts).
// An extension cannot: there is no shell setting env for the extension host,
// and a user cannot restart it with different variables. Same names, same
// defaults, different mechanism.

import * as vscode from "vscode";

export const SECTION = "promptconnext";

export interface ExtensionConfig {
  apiUrl: string;
  webUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  closeTasksFromCommits: boolean;
  commitScanLimit: number;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    apiUrl: trimSlash(cfg.get<string>("cloudApiUrl", "")),
    webUrl: trimSlash(cfg.get<string>("cloudWebUrl", "")),
    supabaseUrl: trimSlash(cfg.get<string>("supabaseUrl", "")),
    supabaseAnonKey: cfg.get<string>("supabaseAnonKey", ""),
    closeTasksFromCommits: cfg.get<boolean>("closeTasksFromCommits", true),
    commitScanLimit: cfg.get<number>("commitScanLimit", 1000),
  };
}

/** The cloud project a workspace folder belongs to, if it has been linked.
 *  Resource-scoped, so a team can commit it in .vscode/settings.json — a
 *  project id is not a secret. */
export function projectIdFor(folder: vscode.Uri): string | undefined {
  const value = vscode.workspace
    .getConfiguration(SECTION, folder)
    .get<string>("projectId", "");
  return value.trim() || undefined;
}

export async function setProjectId(
  folder: vscode.WorkspaceFolder,
  projectId: string,
): Promise<void> {
  await vscode.workspace
    .getConfiguration(SECTION, folder.uri)
    .update("projectId", projectId, vscode.ConfigurationTarget.WorkspaceFolder);
}
