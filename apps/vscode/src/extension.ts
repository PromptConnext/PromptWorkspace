// Wiring only. Every decision worth arguing about lives in the module it
// belongs to; this file exists to construct them, inject the vscode-backed
// implementations of the small interfaces the pure modules take, and register
// the commands.

import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { SignInFlow } from "./auth/signIn.ts";
import {
  CONNECTED,
  cachedLabel,
  connectionState,
  type Connection,
  type ConnectionKind,
  type FolderLink,
} from "./auth/status.ts";
import { CloudClient } from "@promptworkspace/cloud-client";
import { SessionStore } from "@promptworkspace/cloud-client";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  isClosed,
  type TaskStatus,
} from "@promptworkspace/cloud-client";
import { projectIdFor, readConfig } from "./config.ts";
import { ContextViewProvider } from "./context/contextView.ts";
import { RepoDocs } from "./context/repoDocs.ts";
import { createGitBridge } from "./git/gitBridge.ts";
import { GitWatcher } from "./git/gitWatcher.ts";
import { activeProject, type ActiveProject } from "./link/activeProject.ts";
import { ProjectLink } from "./link/projectLink.ts";
import { cloneProject } from "./projects/cloneProject.ts";
import { clearCloneState, readPendingClone } from "./projects/knownClones.ts";
import { linkCandidatesFrom } from "./projects/roster.ts";
import { RosterStore } from "./projects/rosterStore.ts";
import { RosterTreeProvider, ProjectTreeNode, type RosterNode } from "./projects/rosterTree.ts";
import { ALL_CACHE_FILES, CACHE_FILES, JsonCache, type FileStoreLike } from "@promptworkspace/cloud-client";
import { buildTaskContext } from "./tasks/copyContext.ts";
import { StatusQueue, type QueueEntry } from "@promptworkspace/cloud-client";
import { startTask } from "./tasks/startTask.ts";
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
  statusBar.command = "promptworkspace.flushQueue";
  const refreshStatusBar = () => {
    if (queue.size() === 0) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(cloud-upload) PromptWorkspace: ${queue.size()} pending`;
    statusBar.tooltip = "Task updates waiting to reach the cloud. Click to retry.";
    statusBar.show();
  };
  const writer = new StatusWriter(client, store, queue, log, refreshStatusBar);

  const docs = new RepoDocs(client, log);
  const git = await createGitBridge(log);
  const link = new ProjectLink(git, log, context.globalState);
  // The watcher is constructed after the views (it needs the roster to answer
  // "what is this project's default branch"), so the tree reaches it through
  // a holder rather than the other way round. Before it exists, nothing is
  // pending — which is true, not a placeholder.
  let watcher: GitWatcher | undefined;
  // Signed out / unlinked (findings #37, #42), recomputed by renderConnection
  // below; the trees read it for their banner row.
  let connection: Connection = CONNECTED;
  const tree = new TaskTreeProvider(
    store,
    activeProject,
    (projectId) => (watcher ? watcher.pendingRefsFor(projectId) : EMPTY_PENDING),
    () => connection,
  );
  const contextView = new ContextViewProvider(context.extensionUri, docs, activeProject);
  const signIn = new SignInFlow(client, context.globalState, log);

  const treeView = vscode.window.createTreeView("promptworkspace.tasks", {
    treeDataProvider: tree,
  });
  const roster = new RosterStore(client, cache, log);
  const rosterTree = new RosterTreeProvider(
    roster,
    store,
    git,
    context.globalState,
    () => connection,
  );
  const projectsView = vscode.window.createTreeView("promptworkspace.projects", {
    treeDataProvider: rosterTree,
  });
  const connectionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 6);
  context.subscriptions.push(
    treeView,
    projectsView,
    rosterTree,
    statusBar,
    connectionItem,
    store,
    tree,
    contextView,
    git,
    vscode.window.registerWebviewViewProvider(ContextViewProvider.viewType, contextView),
  );

  // ------------------------------------------------------------- reactions

  const setSignedInContext = (signedIn: boolean) =>
    vscode.commands.executeCommand("setContext", "promptworkspace.signedIn", signedIn);

  const setActiveProjectContext = (active: ActiveProject | undefined) =>
    vscode.commands.executeCommand(
      "setContext",
      "promptworkspace.hasActiveProject",
      active !== undefined,
    );

  // The task list only knows a project's name if that project has tasks
  // assigned to this developer; the roster knows every project's name
  // regardless. Falling back to the roster before the literal placeholder is
  // what lets an assignment-less active project still show its real name.
  const projectNameFor = (projectId: string): string => {
    const assigned = store.forProject(projectId)[0]?.project_name;
    if (assigned) return assigned;
    for (const workspace of rosterTree.rows()) {
      const row = workspace.projects.find((p) => p.projectId === projectId);
      if (row) return row.projectName;
    }
    return "this project";
  };

  // ADR 0022 forbids hardcoding `main`: the cloud knows each project's default
  // branch and the roster already carries it. Null when the roster has never
  // reached the cloud, which the watcher handles by assuming the usual names.
  const defaultBranchFor = (projectId: string): string | null => {
    for (const workspace of rosterTree.rows()) {
      const row = workspace.projects.find((p) => p.projectId === projectId);
      if (row) return row.defaultBranch;
    }
    return null;
  };

  // The view title names the active project rather than the signed-in account
  // — an empty tree that does not say *which* project it is empty for is the
  // failure this prevents. Who is signed in moves to the Projects view in a
  // later task; sign-out stays reachable from the view title menu regardless.
  const showTitle = () => {
    const active = activeProject();
    const project = active ? projectNameFor(active.projectId) : undefined;
    if (connection.state === "signed_out") {
      // A cached list shown while signed out must say so (#42): it used to
      // read "updated 11:24 PM" for hours while every refresh failed.
      treeView.description =
        store.all().length > 0
          ? [project, cachedLabel(store.refreshedAt, formatTime)].filter(Boolean).join(" · ")
          : undefined;
      return;
    }
    if (!session.read()) {
      treeView.description = undefined;
      return;
    }
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
    if (connection.state === "signed_out") {
      return roster.all().length > 0 ? cachedLabel(roster.refreshedAt, formatTime) : undefined;
    }
    const current = session.read();
    if (!current) return undefined;
    const who = current.email ?? current.userId;
    if (roster.lastRefreshError) return `${who} · offline`;
    return roster.refreshedAt
      ? `${who} · updated ${new Date(roster.refreshedAt).toLocaleTimeString()}`
      : who;
  };

  // Candidates come from the roster, not the task list: a project with no
  // work assigned to this developer still needs to be linkable.
  const candidates = () => linkCandidatesFrom(rosterTree.rows());

  // One answer to "is this window connected?" for the status bar, both trees'
  // banner rows, the view descriptions, the signed-in context key and one
  // notification per window per state. Called from every event that can
  // change it; cheap (a roster rebuild and a config read per folder).
  const notified = new Set<ConnectionKind>();
  const folderLinks = (linkable: ReturnType<typeof candidates>): FolderLink[] =>
    (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => git.repositoryFor(folder.uri) !== undefined)
      .map((folder) => ({
        name: folder.name,
        linked: projectIdFor(folder.uri) !== undefined,
        hasMatch: link.candidatesFor(folder.uri, linkable).length > 0,
      }));
  const renderConnection = () => {
    const linkable = candidates();
    const next = connectionState(
      {
        stored: session.read() !== null,
        authFailed: store.lastRefreshAuthFailed || roster.lastRefreshAuthFailed,
      },
      { cached: store.all().length > 0 || roster.all().length > 0, linkable: linkable.length },
      folderLinks(linkable),
    );
    const changed = next.state !== connection.state || next.message !== connection.message;
    connection = next;
    void setSignedInContext(next.state !== "signed_out");
    if (next.statusText) {
      connectionItem.text = next.statusText;
      connectionItem.tooltip = next.message;
      connectionItem.command = next.action?.command;
      connectionItem.show();
    } else {
      connectionItem.hide();
    }
    if (changed) {
      tree.refresh();
      rosterTree.refresh();
    }
    showTitle();
    projectsView.description = describeRoster();
    const action = next.action;
    if (next.notify && action && !notified.has(next.state)) {
      notified.add(next.state);
      void vscode.window.showWarningMessage(next.message, action.title).then((choice) => {
        if (choice === action.title) void vscode.commands.executeCommand(action.command);
      });
    }
  };

  // Shared by every event that can change the answer to "which project is
  // the active one": switching the focused editor, editing
  // `promptworkspace.projectId` directly, and adding or removing a workspace
  // folder — including `git.clone`'s own "Add to Workspace" answer, which
  // changes `workspaceFolders` with no editor event and no config event of
  // its own. The three reactions used to duplicate this body verbatim; this
  // is the one copy.
  //
  // No `rosterTree.refresh()` here: `rosterTree.rows()` does not read the
  // active project at all, so refreshing it in reaction to "which project is
  // active changed" was always a no-op — one that forces a full tree rebuild
  // (a synchronous `existsSync` per known clone) for nothing. It is kept
  // current by `store.onDidChange`, `roster.onDidChange` and
  // `git.onDidChangeRepositoryState` instead, which are the events that
  // actually affect its rows.
  const reactToActiveProjectChange = async () => {
    const active = activeProject();
    await setActiveProjectContext(active);
    tree.refresh();
    renderConnection();
    await contextView.render();
  };

  context.subscriptions.push(
    store.onDidChange(() => {
      tree.refresh();
      rosterTree.refresh();
      renderConnection();
    }),
    roster.onDidChange(() => {
      rosterTree.refresh();
      renderConnection();
      void link.offerLinks(candidates());
    }),
    git.onDidChangeRepositoryState(() => rosterTree.refresh()),
    // Another window signing in or out changes the shared secrets without an
    // event on this window's SessionStore; this is the only signal we get.
    context.secrets.onDidChange(() => renderConnection()),
    // A freshly cloned window can activate before vscode.git has finished
    // discovering the repository `git.clone` just created (getAPI(1) returns
    // ahead of discovery — see gitBridge.ts). The activation-time call to
    // applyPendingClone below can therefore find no remotes to match against
    // at all. This retries once a repository actually shows up, guarded by a
    // Memento read so the common case — no clone in flight — costs nothing
    // more than that.
    git.onDidOpenRepository(() => {
      // A repository appearing can make this window "unlinked".
      renderConnection();
      if (!readPendingClone(context.globalState)) return;
      void link.applyPendingClone(candidates());
    }),
    session.onDidChange((current) => {
      renderConnection();
      if (current) {
        // Then look at git again: commits held while signed out can close now.
        void store.refresh().then(() => writer.flush()).then(() => watcher?.scanAll());
        void roster.refresh();
      } else {
        void store.clear();
        void roster.clear();
        void clearCloneState(context.globalState);
        void queue.clear().then(refreshStatusBar);
        // Otherwise a folder user A declined to link stays declined for user
        // B in the same window session — `promptedFolders` has no other way
        // to learn the account changed.
        link.clearPromptedFolders();
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
    vscode.window.onDidChangeActiveTextEditor(() => reactToActiveProjectChange()),
    // Linking a folder to a project writes `promptworkspace.projectId` straight
    // to configuration — no editor event fires for that, so without this the
    // task tree, the view titles and the context webview would all sit stale
    // until the user happened to switch files afterward. Same reaction as an
    // editor switch, because the underlying question — "which project is this
    // folder now" — is identical either way.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("promptworkspace.projectId")) return;
      await reactToActiveProjectChange();
    }),
    // Adding or removing a workspace folder changes "which project am I in"
    // exactly as much as switching the active editor does, but neither the
    // editor-change nor the config-change reaction above fires for it. This
    // is the gap that let `git.clone`'s own "Add to Workspace" answer — one
    // of the three buttons this extension's own clone flow presents — leave
    // `promptworkspace.hasActiveProject`, the task tree, the view descriptions
    // and the context webview all showing the previous folder's project.
    vscode.workspace.onDidChangeWorkspaceFolders(() => reactToActiveProjectChange()),
  );

  // -------------------------------------------------------------- commands

  const taskFromNode = (node?: TreeNode) =>
    node && node.kind === "task" ? node.entry : undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("promptworkspace.signIn", () => signIn.start()),
    vscode.commands.registerCommand("promptworkspace.signInWithCode", () =>
      signIn.withCode(),
    ),
    vscode.commands.registerCommand("promptworkspace.signOut", async () => {
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
    vscode.commands.registerCommand("promptworkspace.refreshTasks", async () => {
      await vscode.window.withProgress(
        { location: { viewId: "promptworkspace.tasks" } },
        async () => {
          await store.refresh();
          await writer.flush();
          // Forced: the user explicitly asked for a refresh, and the active
          // project id/folder have not changed, so the unforced comparison in
          // contextView.render() would otherwise skip it.
          await contextView.render(true);
        },
      );
      renderConnection();
      const failure = store.lastRefreshError;
      if (!failure) return;
      const choice = await vscode.window.showWarningMessage(
        `PromptWorkspace could not reach the cloud: ${failure}. Showing the tasks it had.`,
        "Show Log",
      );
      if (choice === "Show Log") log.show();
    }),
    vscode.commands.registerCommand("promptworkspace.flushQueue", async () => {
      await queue.retryAll();
      await writer.flush();
      refreshStatusBar();
    }),
    // The row click (finding #36): the three things a developer clicking a
    // task most likely wants, with Start first unless the task is closed.
    vscode.commands.registerCommand(
      "promptworkspace.taskActions",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        const actions = [
          {
            label: "$(play) Start Task",
            detail: "Assign it to you, mark it in progress and switch to its branch.",
            command: "promptworkspace.startTask",
          },
          {
            label: "$(clippy) Copy Task Context",
            detail: "Title, criteria, spec and coding rules, for an AI agent.",
            command: "promptworkspace.copyTaskContext",
          },
          {
            label: "$(link-external) Open in the Web App",
            command: "promptworkspace.openTaskInWeb",
          },
        ];
        if (isClosed(entry.task.status)) actions.push(actions.shift()!);
        const picked = await vscode.window.showQuickPick(actions, { title: entry.task.title });
        if (picked) await vscode.commands.executeCommand(picked.command, node);
      },
    ),
    vscode.commands.registerCommand(
      "promptworkspace.copyTaskContext",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        await vscode.env.clipboard.writeText(await buildTaskContext(entry, client, docs, log));
        void vscode.window.showInformationMessage(
          `Copied context for ${entry.task.feature_tag ?? entry.task.title}.`,
        );
      },
    ),
    vscode.commands.registerCommand(
      "promptworkspace.startTask",
      async (node?: TreeNode) => {
        const entry = taskFromNode(node);
        if (!entry) return;
        await startTask(entry, {
          assign: (projectId, taskId, userId) =>
            client.assignTask(projectId, taskId, userId),
          writer,
          git,
          link,
          currentUserId: () => session.read()?.userId,
          log,
        });
        await store.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "promptworkspace.setTaskStatus",
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
      "promptworkspace.openTaskInWeb",
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
      "promptworkspace.openProjectInWeb",
      async (node?: RosterNode) => {
        const { webUrl } = readConfig();
        if (!webUrl) {
          void vscode.window.showErrorMessage(
            "Set promptworkspace.cloudWebUrl before opening the web app.",
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
    vscode.commands.registerCommand("promptworkspace.linkProject", () =>
      link.linkInteractively(candidates()),
    ),
    vscode.commands.registerCommand("promptworkspace.showLog", () => log.show()),
    vscode.commands.registerCommand("promptworkspace.refreshProjects", async () => {
      await vscode.window.withProgress(
        { location: { viewId: "promptworkspace.projects" } },
        () => roster.refresh(),
      );
      renderConnection();
      const failure = roster.lastRefreshError;
      if (!failure) return;
      const choice = await vscode.window.showWarningMessage(
        `PromptWorkspace could not reach the cloud: ${failure}. Showing the projects it had.`,
        "Show Log",
      );
      if (choice === "Show Log") log.show();
    }),
    vscode.commands.registerCommand(
      "promptworkspace.cloneProject",
      async (node?: RosterNode) => {
        if (!(node instanceof ProjectTreeNode)) return;
        await cloneProject(node.row, context.globalState, log);
      },
    ),
    vscode.commands.registerCommand(
      "promptworkspace.openProjectFolder",
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

  await setActiveProjectContext(activeProject());
  refreshStatusBar();
  await store.loadFromCache();
  await roster.loadFromCache();
  renderConnection();
  // Off the cache, not the refresh: this is what makes a freshly cloned
  // window link itself before it has ever reached the network. The fast
  // path — repository discovery already finished by the time we get here.
  // The `onDidOpenRepository` subscription above covers the slow path.
  await link.applyPendingClone(candidates());

  watcher = new GitWatcher(
    git,
    store,
    writer,
    link,
    cache,
    log,
    () => readConfig().closeTasksFromCommits,
    () => readConfig().commitScanLimit,
    () => readConfig().closeTasksOn,
    defaultBranchFor,
    () => session.read() !== null,
  );
  context.subscriptions.push(watcher, watcher.onDidChangePending(() => tree.refresh()));
  watcher.start();

  if (session.read()) {
    await store.refresh();
    await roster.refresh();
    await writer.flush();
    // The scan `watcher.start()` ran above found an empty task list: look
    // again now that it is loaded (commits it held are retried here).
    await watcher.scanAll();
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

const EMPTY_PENDING: ReadonlySet<string> = new Set();

const formatTime = (ms: number) => new Date(ms).toLocaleTimeString();

export { ALL_CACHE_FILES };
