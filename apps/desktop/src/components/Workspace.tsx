import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  getCloudRoster,
  listProjects,
  openCloudProject,
  refreshCloudRoster,
  type CloudRoster,
  type Project,
} from "../api";
import ThreeS from "./ThreeS";
import CloudConnect from "./CloudConnect";
import CloudOpenPanel, { ProjectNotReadyPanel } from "./CloudOpenPanel";
import ImportLocalProjects from "./ImportLocalProjects";
import TopBar, { type ProjectTab, type WorkspaceContext } from "./TopBar";
import { membershipGateEnabled } from "../cloudGate";

export default function Workspace({ onGateRecheck }: { onGateRecheck?: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [roster, setRoster] = useState<CloudRoster>({
    workspaces: [],
    projects: [],
    syncedAt: null,
  });
  const [active, setActive] = useState<Project | null>(null);
  // The tab key currently open. Kept explicit (rather than derived) because the
  // open project can be reached via either a cloud tab or a local pending tab.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    connected: false,
    active: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const [plannerSignal, setPlannerSignal] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pendingCloudOpen, setPendingCloudOpen] = useState<
    { key: string; cloudId: string; name: string; repoUrl: string | null } | null
  >(null);
  // A cloud tab with no local counterpart that hasn't reached repo_created:
  // there's nothing to open yet, so this renders an informational panel
  // instead of the folder-picker (plan: cloud creates the repo at
  // tech-review exit).
  const [notReadyProject, setNotReadyProject] = useState<
    { name: string; lifecycleStatus: string } | null
  >(null);
  const [openBusy, setOpenBusy] = useState(false);

  const refresh = () =>
    listProjects().then((r) => setProjects(r.projects)).catch(() => {});

  // Roster is read from the local cache (no network) — it renders offline and
  // reflects the last cloud-authoritative pull driven by TopBar/App.
  const refreshRoster = () => getCloudRoster().then(setRoster).catch(() => {});

  useEffect(() => {
    refresh();
    refreshRoster();
  }, []);

  // Catch membership/project revocations live (ADR 0015 state 6): on window
  // focus, re-pull the cloud-authoritative roster so a project the user was
  // removed from disappears from the tab list. Offline, the engine serves the
  // cache; in relaxed/stub mode the refresh 401s and is swallowed (tabs come
  // from local projects there anyway). Full membership loss (0 workspaces) is
  // handled a level up by App's own focus-driven gate recheck.
  useEffect(() => {
    const onFocus = () => {
      refreshCloudRoster()
        .then((r) => setRoster({ workspaces: r.workspaces, projects: r.projects, syncedAt: r.syncedAt }))
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const activeWorkspaceId = workspaceCtx.active?.id ?? null;

  // Roster-driven navigation (ADR 0015 G3). When signed in, the cloud roster is
  // the authority for which projects exist in the active workspace — a project
  // the user was removed from simply disappears on the next roster pull. When
  // the gate is relaxed (not connected: stub/dev/cloud-off), fall back to the
  // flat local project list so local-only testing keeps working.
  const tabs: ProjectTab[] = useMemo(() => {
    if (!workspaceCtx.connected) {
      return projects.map((p) => ({ key: `local:${p.id}`, name: p.name }));
    }
    if (!activeWorkspaceId) return [];
    const rosterForWs = roster.projects.filter((p) => p.workspace_id === activeWorkspaceId);
    // lifecycle_status/repo_url ride along so TopBar can render a muted badge
    // for the three pre-repo states, and selectTab can decide clone vs. init
    // vs. "not ready yet" without a second roster lookup.
    const rosterTabs = rosterForWs.map((p) => ({
      key: `cloud:${p.id}`,
      name: p.name,
      lifecycle_status: p.lifecycle_status,
      repo_url: p.repo_url,
    }));
    // Include locally-created projects bound to this workspace that haven't hit
    // the roster yet (offline / pending-sync), so a just-created project never
    // vanishes before its first successful sync. G4 removes G3's name-based
    // ambiguity: a project that already carries a cloud project id is deduped
    // precisely by that id, so a duplicate name can no longer hide a distinct
    // pending project behind the wrong roster tab. Name matching is kept only as
    // the fallback for a project that has never been linked (no cloud id yet).
    const rosterIds = new Set(rosterForWs.map((p) => p.id));
    const rosterNames = new Set(rosterForWs.map((p) => p.name));
    const pendingTabs = projects
      .filter((p) => {
        if (p.cloud_workspace_id !== activeWorkspaceId) return false;
        return p.cloud_project_id
          ? !rosterIds.has(p.cloud_project_id)
          : !rosterNames.has(p.name);
      })
      .map((p) => ({ key: `local:${p.id}`, name: p.name }));
    return [...rosterTabs, ...pendingTabs];
  }, [workspaceCtx.connected, activeWorkspaceId, roster, projects]);

  // Resolve a tab selection to a usable local project. A cloud tab that's
  // already been opened before is idempotent/instant (unchanged); a cloud tab
  // with no local project yet pauses on a folder-picker panel instead of
  // silently materializing one at the default path. A local tab is already
  // local.
  const selectTab = async (key: string) => {
    setOpenError(null);
    setNotReadyProject(null);
    if (key.startsWith("local:")) {
      const id = key.slice("local:".length);
      const p = projects.find((x) => x.id === id) ?? null;
      if (p) {
        setActive(p);
        setActiveKey(key);
        setPendingCloudOpen(null);
      }
      return;
    }
    const cloudId = key.slice("cloud:".length);
    const alreadyLocal = projects.some((p) => p.cloud_project_id === cloudId);
    if (alreadyLocal) {
      await finishCloudOpen(cloudId, key);
      return;
    }
    const rosterProject = roster.projects.find((p) => p.id === cloudId);
    setActive(null);
    setActiveKey(key);
    // Not yet repo_created and no local copy on this machine: there's nothing
    // to open or clone, so show an informational panel instead of the
    // folder-picker — never set pendingCloudOpen for this state (plan: cloud
    // creates the repo at tech-review exit).
    if (rosterProject && rosterProject.lifecycle_status !== "repo_created") {
      setPendingCloudOpen(null);
      setNotReadyProject({ name: rosterProject.name, lifecycleStatus: rosterProject.lifecycle_status });
      return;
    }
    setPendingCloudOpen({
      key,
      cloudId,
      name: rosterProject?.name ?? "this project",
      repoUrl: rosterProject?.repo_url ?? null,
    });
  };

  // Shared by the already-opened fast path above and both CloudOpenPanel
  // actions below — `path` is omitted for "Use default location".
  const finishCloudOpen = async (cloudId: string, key: string, path?: string) => {
    setOpenBusy(true);
    setOpenError(null);
    try {
      const { localProjectId } = await openCloudProject(cloudId, path);
      const r = await listProjects();
      setProjects(r.projects);
      const p = r.projects.find((x) => x.id === localProjectId) ?? null;
      setActive(p);
      setActiveKey(key);
      setPendingCloudOpen(null);
    } catch (err) {
      // The engine's 409 (project_not_ready / folder collision) and 502
      // (clone failure, with an actionable "run `gh auth login`…" message)
      // bodies are already human-readable — surface them verbatim.
      setOpenError((err as Error).message);
    } finally {
      setOpenBusy(false);
    }
  };

  const create = async (name: string) => {
    // When signed in, the engine binds the new project to the active workspace
    // server-side (workspace_id required, ADR 0015 §5); when the gate is relaxed
    // it stays a plain local project. Either way, refresh both views and open it.
    const project = await createProject(name);
    setPendingCloudOpen(null);
    setNotReadyProject(null);
    await refresh();
    await refreshRoster();
    setActive(project);
    setActiveKey(`local:${project.id}`);
  };

  const activeTabKey = activeKey && tabs.some((t) => t.key === activeKey) ? activeKey : null;

  // Existing local-only projects (never linked to a workspace) — the roster
  // hides them under the gate, so offer a one-time import (plan 0006 G4). Only
  // meaningful once a real cloud identity with a workspace is in play, so this
  // stays behind the same feature flag as the rest of the gate (relaxed
  // stub/dev/cloud-off keeps today's flat local list, where these are visible).
  const localOnlyProjects = projects.filter((p) => p.cloud_workspace_id === null);
  const showImport =
    membershipGateEnabled && workspaceCtx.connected && roster.workspaces.length > 0;

  return (
    <div className="workspace">
      <TopBar
        tabs={tabs}
        activeTabKey={activeTabKey}
        activeProject={active}
        onSelectTab={selectTab}
        onCreateProject={create}
        reloadSignal={refreshTick}
        onGateRecheck={onGateRecheck}
        onOpenPlanner={() => setPlannerSignal((t) => t + 1)}
        onWorkspaceContextChange={(ctx) => {
          setWorkspaceCtx(ctx);
          void refresh();
          void refreshRoster();
        }}
      />
      <div className="content">
        {showImport && (
          <ImportLocalProjects
            localOnly={localOnlyProjects}
            workspaces={roster.workspaces}
            onImported={() => {
              void refresh();
              void refreshRoster();
            }}
          />
        )}
        {openError && <p className="error">{openError}</p>}
        {notReadyProject ? (
          <ProjectNotReadyPanel
            projectName={notReadyProject.name}
            lifecycleStatus={notReadyProject.lifecycleStatus}
          />
        ) : pendingCloudOpen ? (
          <CloudOpenPanel
            projectName={pendingCloudOpen.name}
            mode={pendingCloudOpen.repoUrl ? "clone" : "init"}
            repoUrl={pendingCloudOpen.repoUrl}
            busy={openBusy}
            onChooseFolder={(path) =>
              finishCloudOpen(pendingCloudOpen.cloudId, pendingCloudOpen.key, path)
            }
            onUseDefault={() => finishCloudOpen(pendingCloudOpen.cloudId, pendingCloudOpen.key)}
          />
        ) : active ? (
          <>
            <CloudConnect
              key={active.id}
              projectId={active.id}
              onChange={() => setRefreshTick((t) => t + 1)}
            />
            <ThreeS key={active.id} project={active} focusSignal={plannerSignal} />
          </>
        ) : (
          <p className="muted">Select or create a project to start the 3S flow.</p>
        )}
      </div>
    </div>
  );
}
