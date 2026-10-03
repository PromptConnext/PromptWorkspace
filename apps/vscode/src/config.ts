// Settings.
//
// The engine read all of this from process.env (apps/engine/src/config.ts).
// An extension cannot: there is no shell setting env for the extension host,
// and a user cannot restart it with different variables. Same names, same
// defaults, different mechanism.

import * as vscode from "vscode";

export const SECTION = "promptworkspace";

/** When a commit becomes a status write. `push` holds the close until the
 *  commit reaches the remote (ADR 0022); `commit` is the pre-0.3 behaviour,
 *  and is also what a repository with no upstream falls back to. */
export type CloseTasksOn = "commit" | "push";

export interface ExtensionConfig {
  apiUrl: string;
  webUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  closeTasksFromCommits: boolean;
  closeTasksOn: CloseTasksOn;
  commitScanLimit: number;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readCloseTasksOn(cfg: vscode.WorkspaceConfiguration): CloseTasksOn {
  const raw = cfg.get<string>("closeTasksOn", "push");
  return raw === "commit" ? "commit" : "push";
}

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    apiUrl: trimSlash(cfg.get<string>("cloudApiUrl", "")),
    webUrl: trimSlash(cfg.get<string>("cloudWebUrl", "")),
    supabaseUrl: trimSlash(cfg.get<string>("supabaseUrl", "")),
    supabaseAnonKey: cfg.get<string>("supabaseAnonKey", ""),
    // Superseded by `closeTasksOn` but still read: someone who turned the
    // watcher off must not have it turned back on by an upgrade. Only the
    // explicit `false` survives — the default `true` says nothing about
    // which trigger they want.
    closeTasksFromCommits: cfg.get<boolean>("closeTasksFromCommits", true),
    closeTasksOn: readCloseTasksOn(cfg),
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
