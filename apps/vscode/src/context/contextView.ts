// The "Project Context" webview: the three seeded files, as they are on disk.
//
// Rendered as <pre>, deliberately. A markdown renderer is a dependency and a
// CSP decision, and neither buys anything here — the audience that wants prose
// has apps/web. "Open in editor" hands the file to the editor, which renders
// markdown better than we would anyway.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { projectIdFor } from "../config.ts";
import type { RepoDocs, RepoDocContents } from "./repoDocs.ts";

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "promptconnext.context";

  private view: vscode.WebviewView | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];

  private readonly extensionUri: vscode.Uri;
  private readonly docs: RepoDocs;

  constructor(
    extensionUri: vscode.Uri,
    docs: RepoDocs,
  ) {
    this.extensionUri = extensionUri;
    this.docs = docs;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage(async (msg: { type: string; path?: string }) => {
      if (msg.type === "open" && msg.path) {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return;
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(folder.uri, msg.path),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      }
      if (msg.type === "refresh") void this.render();
    });
    view.onDidDispose(() => this.disposeWatchers());
    void this.render();
  }

  async render(): Promise<void> {
    if (!this.view) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.view.webview.html = this.page(
        "<p class='empty'>Open a project folder to see its coding rules.</p>",
      );
      return;
    }
    const docs = await this.docs.readAll(folder.uri);
    const projectId = projectIdFor(folder.uri);
    const drifted = projectId
      ? await this.docs.constitutionDrifted(projectId, folder.uri)
      : undefined;
    this.view.webview.html = this.page(this.body(docs, drifted));
    this.watch(folder);
  }

  private body(docs: RepoDocContents[], drifted: boolean | undefined): string {
    const notice =
      drifted === true
        ? `<p class="notice">The cloud's constitution has changed since this file was seeded.</p>`
        : "";
    const sections = docs
      .map((doc) => {
        const header =
          `<h2>${escapeHtml(doc.label)}` +
          `<button data-path="${escapeHtml(doc.path)}">Open in editor</button></h2>`;
        const content =
          doc.text === null
            ? `<p class="empty">Not present in this repository (${escapeHtml(doc.path)}).</p>`
            : `<pre>${escapeHtml(doc.text)}</pre>`;
        return `<section>${header}${content}</section>`;
      })
      .join("");
    return notice + sections;
  }

  private page(body: string): string {
    const nonce = newNonce();
    const csp =
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0 8px 16px; }
  h2 { font-size: 1em; display: flex; align-items: center; justify-content: space-between;
       gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  button { background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 8px;
           cursor: pointer; font-size: 0.9em; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family);
        font-size: 0.95em; background: var(--vscode-textCodeBlock-background); padding: 8px;
        max-height: 24em; overflow: auto; }
  .empty, .notice { color: var(--vscode-descriptionForeground); font-style: italic; }
  .notice { border-left: 2px solid var(--vscode-editorWarning-foreground); padding-left: 8px; }
</style>
</head>
<body>
${body}
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  for (const button of document.querySelectorAll("button[data-path]")) {
    button.addEventListener("click", () =>
      vscodeApi.postMessage({ type: "open", path: button.dataset.path }));
  }
</script>
</body>
</html>`;
  }

  private watch(folder: vscode.WorkspaceFolder): void {
    this.disposeWatchers();
    for (const pattern of [
      "AGENTS.md",
      "docs/conventions.md",
      ".specify/memory/constitution.md",
    ]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern),
      );
      const rerender = () => void this.render();
      watcher.onDidChange(rerender);
      watcher.onDidCreate(rerender);
      watcher.onDidDelete(rerender);
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
  }

  dispose(): void {
    this.disposeWatchers();
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 128 bits from the CSPRNG. `Math.random()` would be wrong here and not
// merely unfashionable: the nonce is the whole CSP control, so a predictable
// one lets injected markup satisfy the policy it exists to enforce.
function newNonce(): string {
  return randomBytes(16).toString("base64");
}
