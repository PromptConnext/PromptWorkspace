// The "Project Context" webview: the three seeded files, as they are on disk.
//
// Rendered as <pre>, deliberately. A markdown renderer is a dependency and a
// CSP decision, and neither buys anything here — the audience that wants prose
// has apps/web. "Open in editor" hands the file to the editor, which renders
// markdown better than we would anyway.

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { ActiveProject } from "../link/activeProject.ts";
import type { RepoDocs, RepoDocContents } from "./repoDocs.ts";

export class ContextViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "promptconnext.context";

  private view: vscode.WebviewView | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];
  // What the webview currently shows: `projectId:folderUri`, or undefined for
  // the "no active project" placeholder. `render()` compares against this to
  // skip the `constitutionDrifted()` cloud round trip (and the watcher
  // teardown/recreate) on every editor-focus and config-change reaction when
  // neither actually changed which project is active — see the `force`
  // parameter below for the paths that must still re-render regardless.
  private lastRenderKey: string | undefined;

  private readonly extensionUri: vscode.Uri;
  private readonly docs: RepoDocs;
  private readonly active: () => ActiveProject | undefined;

  constructor(
    extensionUri: vscode.Uri,
    docs: RepoDocs,
    active: () => ActiveProject | undefined,
  ) {
    this.extensionUri = extensionUri;
    this.docs = docs;
    this.active = active;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage(async (msg: { type: string; path?: string }) => {
      if (msg.type === "open" && msg.path) {
        const current = this.active();
        if (!current) return;
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.joinPath(current.folder.uri, msg.path),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      }
      if (msg.type === "refresh") void this.render(true);
    });
    view.onDidDispose(() => {
      // Without clearing this, `render()`'s `if (!this.view) return` guard
      // passes for a disposed view, and the assignment to
      // `this.view.webview.html` below throws "Webview is disposed" — now
      // reachable from async handlers (editor switch, config change,
      // workspace-folder change) where the throw becomes an unhandled
      // rejection instead of a visible error.
      this.view = undefined;
      this.disposeWatchers();
    });
    void this.render(true);
  }

  /**
   * @param force Re-render even if the active project id and folder have not
   *   changed since the last successful render. The explicit Refresh command
   *   and the coding-rules file watchers need this — they exist specifically
   *   to show content that changed *without* the active project changing.
   *   Every other caller (editor-focus, config-change, workspace-folder
   *   reactions) leaves this false, because those fire on events that do not
   *   necessarily mean "which project is active" changed, and each render
   *   otherwise costs an authenticated `constitutionDrifted()` cloud request
   *   plus tearing down and recreating three file watchers.
   */
  async render(force = false): Promise<void> {
    if (!this.view) return;
    const current = this.active();
    const key = current ? `${current.projectId}:${current.folder.uri.toString()}` : undefined;
    if (!force && key === this.lastRenderKey) return;
    this.lastRenderKey = key;
    if (!current) {
      this.view.webview.html = this.page(
        "<p class='empty'>Open a project folder to see its coding rules.</p>",
      );
      return;
    }
    const folder = current.folder.uri;
    const docs = await this.docs.readAll(folder);
    const drifted = await this.docs.constitutionDrifted(current.projectId, folder);
    this.view.webview.html = this.page(this.body(docs, drifted));
    this.watch(current.folder);
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
      // Forced: the active project has not changed, only a file inside it —
      // the whole reason this watcher exists is to reflect that content
      // change, so the id/folder cache key comparison in `render()` must not
      // suppress it.
      const rerender = () => void this.render(true);
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
