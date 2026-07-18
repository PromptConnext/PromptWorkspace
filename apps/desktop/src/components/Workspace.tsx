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
import TopBar, { type ProjectTab, type WorkspaceContext } from "./TopBar";

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
  const [openError, setOpenError] = useState<string | null>(null);

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
    const rosterTabs = rosterForWs.map((p) => ({ key: `cloud:${p.id}`, name: p.name }));
    // Include locally-created projects bound to this workspace that haven't hit
    // the roster yet (offline / pending-sync), matched off the roster by name so
    // a just-created project never vanishes before its first successful sync.
    // (Name-based dedupe is best-effort; a rare duplicate-name collision could
    // hide a pending tab until sync — acceptable for v1, noted for G4.)
    const rosterNames = new Set(rosterForWs.map((p) => p.name));
    const pendingTabs = projects
      .filter((p) => p.cloud_workspace_id === activeWorkspaceId && !rosterNames.has(p.name))
      .map((p) => ({ key: `local:${p.id}`, name: p.name }));
    return [...rosterTabs, ...pendingTabs];
  }, [workspaceCtx.connected, activeWorkspaceId, roster, projects]);

  // Resolve a tab selection to a usable local project. A cloud tab is
  // materialized/hydrated via the engine's open endpoint (idempotent — returns
  // the existing local id when present); a local tab is already local.
  const selectTab = async (key: string) => {
    setOpenError(null);
    if (key.startsWith("local:")) {
      const id = key.slice("local:".length);
      const p = projects.find((x) => x.id === id) ?? null;
      if (p) {
        setActive(p);
        setActiveKey(key);
      }
      return;
    }
    const cloudId = key.slice("cloud:".length);
    try {
      const { localProjectId } = await openCloudProject(cloudId);
      const r = await listProjects();
      setProjects(r.projects);
      const p = r.projects.find((x) => x.id === localProjectId) ?? null;
      setActive(p);
      setActiveKey(key);
    } catch (err) {
      setOpenError((err as Error).message);
    }
  };

  const create = async (name: string) => {
    // When signed in, the engine binds the new project to the active workspace
    // server-side (workspace_id required, ADR 0015 §5); when the gate is relaxed
    // it stays a plain local project. Either way, refresh both views and open it.
    const project = await createProject(name);
    await refresh();
    await refreshRoster();
    setActive(project);
    setActiveKey(`local:${project.id}`);
  };

  const activeTabKey = activeKey && tabs.some((t) => t.key === activeKey) ? activeKey : null;

  return (
    <div className="workspace">
      <TopBar
        tabs={tabs}
        activeTabKey={activeTabKey}
        onSelectTab={selectTab}
        onCreateProject={create}
        reloadSignal={refreshTick}
        onGateRecheck={onGateRecheck}
        onWorkspaceContextChange={(ctx) => {
          setWorkspaceCtx(ctx);
          void refresh();
          void refreshRoster();
        }}
      />
      <div className="content">
        {openError && <p className="error">{openError}</p>}
        {active ? (
          <>
            <CloudConnect
              key={active.id}
              projectId={active.id}
              onChange={() => setRefreshTick((t) => t + 1)}
            />
            <ThreeS key={active.id} project={active} />
          </>
        ) : (
          <p className="muted">Select or create a project to start the 3S flow.</p>
        )}
      </div>
    </div>
  );
}
