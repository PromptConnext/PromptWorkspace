// Wiring only. Every decision worth arguing about lives in the module it
// belongs to; this file exists to construct them, inject the vscode-backed
// implementations of the small interfaces the pure modules take, and register
// the commands.

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { SignInFlow } from "./auth/signIn.ts";
import { CloudClient } from "./cloud/client.ts";
import { SessionStore } from "./cloud/session.ts";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isClosed,
  type TaskStatus,
} from "./cloud/types.ts";
import { projectIdFor, readConfig } from "./config.ts";
import { ContextViewProvider } from "./context/contextView.ts";
import { RepoDocs } from "./context/repoDocs.ts";
import { createGitBridge } from "./git/gitBridge.ts";
import { GitWatcher } from "./git/gitWatcher.ts";
import { activeProject, type ActiveProject } from "./link/activeProject.ts";
import { ProjectLink } from "./link/projectLink.ts";
import { clearCloneState } from "./projects/knownClones.ts";
import { RosterStore } from "./projects/rosterStore.ts";
import { RosterTreeProvider, ProjectTreeNode, type RosterNode } from "./projects/rosterTree.ts";
import { ALL_CACHE_FILES, CACHE_FILES, JsonCache, type FileStoreLike } from "./storage/cache.ts";
import { copyTaskContext } from "./tasks/copyContext.ts";
import { StatusQueue, type QueueEntry } from "./tasks/queue.ts";
import { StatusWriter } from "./tasks/statusWriter.ts";
import { TaskStore } from "./tasks/taskStore.ts";
import { TaskTreeProvider, type TreeNode } from "./tasks/treeProvider.ts";
import { OutputLogger } from "./util/log.ts";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new OutputLogger();
  context.subscriptions.push(log);

  const session = new SessionStore(context.secrets, context.globalState);
  const client = new CloudClient({
    session,
    config: () => {
      const cfg = readConfig();
      return {
        apiUrl: cfg.apiUrl,
        supabaseUrl: cfg.supabaseUrl,
        supabaseAnonKey: cfg.supabaseAnonKey,
      };
    },
    fetch: (input, init) => fetch(input, init),
    log,
  });

  const cache = new JsonCache(createFileStore(context.globalStorageUri));
  const queue = new StatusQueue({
    load: () => cache.read<QueueEntry[]>(CACHE_FILES.queue),
    save: (entries) => cache.write(CACHE_FILES.queue, entries),
    now: () => Date.now(),
    newId: () => randomUUID(),
  });
  await queue.load();

  const store = new TaskStore(client, cache, log);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 5);
  statusBar.command = "promptconnext.flushQueue";
  const refreshStatusBar = () => {
    if (queue.size() === 0) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(cloud-upload) PromptConnext: ${queue.size()} pending`;
    statusBar.tooltip = "Task updates waiting to reach the cloud. Click to retry.";
    statusBar.show();
  };
  const writer = new StatusWriter(client, store, queue, log, refreshStatusBar);

  const docs = new RepoDocs(client, log);
  const git = await createGitBridge(log);
  const link = new ProjectLink(git, log);
  const tree = new TaskTreeProvider(store, activeProject);
  const contextView = new ContextViewProvider(context.extensionUri, docs, activeProject);
  const signIn = new SignInFlow(client, context.globalState, log);

  const treeView = vscode.window.createTreeView("promptconnext.tasks", {
    treeDataProvider: tree,
  });
  const roster = new RosterStore(client, cache, log);
  const rosterTree = new RosterTreeProvider(roster, store, git, context.globalState);
  const projectsView = vscode.window.createTreeView("promptconnext.projects", {
    treeDataProvider: rosterTree,
  });
  context.subscriptions.push(
    treeView,
    projectsView,
    rosterTree,
    statusBar,
    store,
    tree,
    contextView,
    git,
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextView),
  );

  // ------------------------------------------------------------- reactions

  const setSignedInContext = (signedIn: boolean) =>
    vscode.commands.executeCommand("setContext", "promptconnext.signedIn", signedIn);

  const setActiveProjectContext = (active: ActiveProject | undefined) =>
    vscode.commands.executeCommand(
      "setContext",
      "promptconnext.hasActiveProject",
      active !== undefined,
    );

  // The view title names the active project rather than the signed-in account
  // — an empty tree that does not say *which* project it is empty for is the
  // failure this prevents. Who is signed in moves to the Projects view in a
  // later task; sign-out stays reachable from the view title menu regardless.
  const showTitle = () => {
    const current = session.read();
    if (!current) {
      treeView.description = undefined;
      return;
    }
    const active = activeProject();
    const project = active
      ? store.forProject(active.projectId)[0]?.project_name ?? "this project"
      : undefined;
    if (store.lastRefreshError) {
      treeView.description = project ? `${project} · offline` : "offline";
      return;
    }
    const at = store.refreshedAt;
    const when = at ? `updated ${new Date(at).toLocaleTimeString()}` : undefined;
    treeView.description = [project, when].filter(Boolean).join(" · ") || undefined;
  };

  // The Projects view carries the account, now that the task view's description
  // carries the project instead. Both also have to say when they last reached
  // the cloud, or a refresh that legitimately changes nothing looks broken.
  const describeRoster = () => {
    const current = session.read();
    if (!current) return undefined;
    const who = current.email ?? current.userId;
    if (roster.lastRefreshError) return `${who} · offline`;
    return roster.refreshedAt
      ? `${who} · updated ${new Date(roster.refreshedAt).toLocaleTimeString()}`
      : who;
  };

  context.subscriptions.push(
    store.onDidChange(() => {
      tree.refresh();
      rosterTree.refresh();
      showTitle();
      void link.offerLinks(store.all());
    }),
    roster.onDidChange(() => {
      rosterTree.refresh();
      projectsView.description = describeRoster();
    }),
    git.onDidChangeRepositoryState(() => rosterTree.refresh()),
    session.onDidChange((current) => {
      void setSignedInContext(current !== null);
      showTitle();
      if (current) {
        void store.refresh().then(() => writer.flush());
        void roster.refresh();
      } else {
        void store.clear();
        void roster.clear();
        void clearCloneState(context.globalState);
        void queue.clear().then(refreshStatusBar);
      }
    }),
    treeView.onDidChangeCheckboxState(async (e) => {
      for (const [node, state] of e.items) {
        if (node.kind !== "task") continue;
        await writer.setStatus({
          projectId: node.entry.project_id,
          taskId: node.entry.task.id,
          status: state === vscode.TreeItemCheckboxState.Checked ? "implemented" : "todo",
        });
      }
    }),
    vscode.window.onDidChangeWindowState(async (state) => {
      if (!state.focused) return;
      await store.refreshOnFocus();
      await roster.refreshOnFocus();
      await writer.flush();
    }),
    vscode.window.registerUriHandler({
      handleUri: (uri) => signIn.handleCallback(uri),
    }),
    // Switching which folder's editor is focused switches which project both
    // views are scoped to — the whole point of following the editor instead
    // of a stored selection (see activeProject.ts).
    vscode.window.onDidChangeActiveTextEditor(async () => {
      const active = activeProject();
      await setActiveProjectContext(active);
      tree.refresh();
      rosterTree.refresh();
      showTitle();
      await contextView.render();
    }),
    // Linking a folder to a project writes `promptconnext.projectId` straight
    // to configuration — no editor event fires for that, so without this the
    // task tree, the view titles and the context webview would all sit stale
    // until the user happened to switch files afterward. Same reaction as an
    // editor switch, because the underlying question — "which project is this
    // folder now" — is identical either way.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("promptconnext.projectId")) return;
      const active = activeProject();
      await setActiveProjectContext(active);
      tree.refresh();
      rosterTree.refresh();
      showTitle();
      await contextView.render();
    }),
  );

  // -------------------------------------------------------------- commands

  const taskFromNode = (node?: TreeNode) =>
    node && node.kind === "task" ? node.entry : undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("promptconnext.signIn", () => signIn.start()),
    vscode.commands.registerCommand("promptconnext.signInWithCode", () =>
      signIn.withCode(),
    ),
    vscode.commands.registerCommand("promptconnext.signOut", async () => {
      if (queue.size() > 0) {
        const choice = await vscode.window.showWarningMessage(
          `${queue.size()} task update(s) have not reached the cloud yet. ` +
            "Signing out discards them.",
          { modal: true },
          "Sign out anyway",
        );
        if (choice !== "Sign out anyway") return;
      }
      await session.clear();
    }),
    // Explicit refresh, unlike the background triggers, owes the user an
    // answer: a progress bar on the view while it runs, and a message if it
    // failed. `store.refresh()` deliberately never rejects (it keeps the
    // cache), so the outcome has to be read back off the store.
    vscode.commands.registerCommand("promptconnext.refreshTasks", async () => {
      await vscode.window.withProgress(
        { location: { viewId: "promptconnext.tasks" } },
        async () => {
          await store.refresh();
          await writer.flush();
          await contextView.render();
        },
      );
      showTitle();
      const failure = store.lastRefreshError;
      if (!failure) return;
      const choice = await vscode.window.showWarningMessage(
        `PromptConnext could not reach the cloud: ${failure}. Showing the tasks it had.`,
        "Show Log",
      );
      if (choice === "Show Log") log.show();
    }),
    vscode.commands.registerCommand("promptconnext.flushQueue", async () => {
      await queue.retryAll();
      await writer.flush();
      refreshStatusBar();
    }),
    vscode.commands.registerCommand(
      "promptconnext.copyTaskContext",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        await copyTaskContext(entry, client, docs, log);
      },
    ),
    vscode.commands.registerCommand(
      "promptconnext.setTaskStatus",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        const picked = await vscode.window.showQuickPick(
          TASK_STATUSES.map((status) => ({
            label: TASK_STATUS_LABELS[status],
            description: isClosed(status) ? "closed" : undefined,
            status,
          })),
          { title: entry.task.title },
        );
        if (!picked) return;
        await writer.setStatus({
          projectId: entry.project_id,
          taskId: entry.task.id,
          status: picked.status as TaskStatus,
        });
      },
    ),
    vscode.commands.registerCommand(
      "promptconnext.openTaskInWeb",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        const { webUrl } = readConfig();
        await vscode.env.openExternal(
          vscode.Uri.parse(
            `${webUrl}/w/${entry.workspace_id}/p/${entry.project_id}?tab=tasks`,
          ),
        );
      },
    ),
    // Task 6 reduced this to the active project because there was no node to
    // receive. Now the Projects view has one, so a right-click on a project row
    // opens *that* project, not whichever one the editor happens to be in; with
    // no node (the view title menu, the welcome view) it falls back to the
    // active project exactly as before.
    vscode.commands.registerCommand(
      "promptconnext.openProjectInWeb",
      async (node?: RosterNode) => {
        const { webUrl } = readConfig();
        if (!webUrl) {
          void vscode.window.showErrorMessage(
            "Set promptconnext.cloudWebUrl before opening the web app.",
          );
          return;
        }
        let path = "";
        if (node instanceof ProjectTreeNode) {
          path = `/w/${node.row.workspaceId}/p/${node.row.projectId}`;
        } else {
          const active = activeProject();
          const entry = active ? store.forProject(active.projectId)[0] : undefined;
          if (entry) path = `/w/${entry.workspace_id}/p/${entry.project_id}`;
        }
        // With no project in view, the web root is the workspace list, which is
        // a useful answer rather than a failure.
        await vscode.env.openExternal(vscode.Uri.parse(`${webUrl}${path}`));
      },
    ),
    vscode.commands.registerCommand("promptconnext.linkProject", () =>
      link.linkInteractively(store.all()),
    ),
    vscode.commands.registerCommand("promptconnext.showLog", () => log.show()),
    vscode.commands.registerCommand("promptconnext.refreshProjects", async () => {
      await vscode.window.withProgress(
        { location: { viewId: "promptconnext.projects" } },
        () => roster.refresh(),
      );
      projectsView.description = describeRoster();
      const failure = roster.lastRefreshError;
      if (!failure) return;
      const choice = await vscode.window.showWarningMessage(
        `PromptConnext could not reach the cloud: ${failure}. Showing the projects it had.`,
        "Show Log",
      );
      if (choice === "Show Log") log.show();
    }),
    vscode.commands.registerCommand(
      "promptconnext.openProjectFolder",
      async (node?: RosterNode) => {
        if (!(node instanceof ProjectTreeNode) || !node.row.localPath) return;
        const uri = vscode.Uri.file(node.row.localPath);
        // Already open in this window: reveal rather than reopen, which would
        // throw away the user's editor layout to show them what they can see.
        const alreadyOpen = (vscode.workspace.workspaceFolders ?? []).some(
          (f) => f.uri.fsPath === uri.fsPath,
        );
        if (alreadyOpen) {
          await vscode.commands.executeCommand("revealInExplorer", uri);
          return;
        }
        await vscode.commands.executeCommand("vscode.openFolder", uri, {
          forceNewWindow: true,
        });
      },
    ),
  );

  // ------------------------------------------------------------- start-up

  await setSignedInContext(session.read() !== null);
  await setActiveProjectContext(activeProject());
  showTitle();
  refreshStatusBar();
  await store.loadFromCache();
  await roster.loadFromCache();
  projectsView.description = describeRoster();

  const watcher = new GitWatcher(
    git,
    store,
    writer,
    link,
    cache,
    log,
    () => readConfig().closeTasksFromCommits,
    () => readConfig().commitScanLimit,
  );
  context.subscriptions.push(watcher);
  watcher.start();

  if (session.read()) {
    await store.refresh();
    await roster.refresh();
    await writer.flush();
    refreshStatusBar();
  }

  log.info(
    `activated (mode=${client.mode()}, folders=${
      vscode.workspace.workspaceFolders?.length ?? 0
    }, linked=${(vscode.workspace.workspaceFolders ?? []).filter((f) =>
      projectIdFor(f.uri),
    ).length})`,
  );
}

export function deactivate(): void {
  // Nothing to tear down: there is no sidecar, no spawned process and no
  // server. That absence is the point of ADR 0019 — if a future change needs
  // real work here, it is reintroducing something that ADR removed.
}

/** globalStorageUri-backed atomic writes, injected into the pure cache. */
function createFileStore(root: vscode.Uri): FileStoreLike {
  const fileUri = (name: string) => vscode.Uri.joinPath(root, name);
  return {
    async read(name) {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(fileUri(name)));
      } catch {
        return undefined;
      }
    },
    async write(name, contents) {
      await vscode.workspace.fs.createDirectory(root);
      // Write-then-rename: a half-written cache file must never be readable,
      // and a crash mid-write must leave the previous one intact.
      const tmp = fileUri(`${name}.tmp`);
      await vscode.workspace.fs.writeFile(tmp, new TextEncoder().encode(contents));
      await vscode.workspace.fs.rename(tmp, fileUri(name), { overwrite: true });
    },
    async delete(name) {
      await vscode.workspace.fs.delete(fileUri(name), { useTrash: false });
    },
  };
}

export { ALL_CACHE_FILES };
