import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cloudLogin,
  cloudLogout,
  getActiveWorkspace,
  getCloudConfig,
  getCloudSession,
  listCloudWorkspaces,
  redeemBrowserLogin,
  setActiveWorkspace,
  startBrowserLogin,
  type ActiveWorkspace,
  type CloudConfig,
  type CloudSession,
  type CloudWorkspace,
} from "../api";

export type WorkspaceContext = {
  connected: boolean;
  active: ActiveWorkspace | null;
};

// A navigable project tab. `key` encodes the source: `cloud:<cloudProjectId>`
// for a roster project (resolved to a local project on select) or
// `local:<localProjectId>` for a purely-local / pending-sync one. Workspace
// owns the roster-driven tab list (ADR 0015 G3); TopBar just renders it.
export type ProjectTab = { key: string; name: string };

// Global navigation shell (replaces the old sidebar project list): one bar
// always visible above the 3S flow, so switching workspace/project or seeing
// who's signed in never requires leaving the current project. Three zones —
// workspace switcher, project tabs, account status — read left to right as
// "where am I, what's in it, who am I".
export default function TopBar({
  tabs,
  activeTabKey,
  onSelectTab,
  onCreateProject,
  reloadSignal,
  onWorkspaceContextChange,
  onGateRecheck,
}: {
  tabs: ProjectTab[];
  activeTabKey: string | null;
  onSelectTab: (key: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  reloadSignal: number;
  onWorkspaceContextChange: (ctx: WorkspaceContext) => void;
  onGateRecheck?: () => void;
}) {
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [active, setActive] = useState<ActiveWorkspace | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);

  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [acctError, setAcctError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const resolveWorkspace = async () => {
    const cloudSession = await getCloudSession();
    if (!cloudSession.connected) {
      // Logged out (or never logged in): clear all workspace state. Under the
      // enforced membership gate (ADR 0015) TopBar only mounts post-gate, so
      // this signed-out path is reached only when the gate is relaxed
      // (stub/dev/cloud-off), where the project list falls back to local.
      setConnected(false);
      setActive(null);
      setWorkspaces([]);
      onWorkspaceContextChange({ connected: false, active: null });
      return;
    }
    setConnected(true);
    const stored = await getActiveWorkspace().catch(() => null);
    let ws: CloudWorkspace[];
    try {
      ws = (await listCloudWorkspaces()).workspaces;
    } catch {
      // Cloud is unreachable — this is NOT the same as "no workspaces". Keep
      // whatever workspace was previously remembered/active instead of
      // dropping to the "no workspaces" picker (ADR 0015 state 4).
      if (stored) {
        setActive(stored);
        onWorkspaceContextChange({ connected: true, active: stored });
        return;
      }
      setWorkspaces([]);
      setActive(null);
      onWorkspaceContextChange({ connected: true, active: null });
      return;
    }
    setWorkspaces(ws);
    // remember-last: stored active still a membership?
    if (stored && ws.some((w) => w.id === stored.id)) {
      setActive(stored);
      onWorkspaceContextChange({ connected: true, active: stored });
      return;
    }
    // auto-enter a single membership
    if (ws.length === 1) {
      await selectWorkspace(ws[0].id);
      return;
    }
    // else: leave unset -> picker renders below
    setActive(null);
    onWorkspaceContextChange({ connected: true, active: null });
  };

  const selectWorkspace = async (id: string) => {
    setWsError(null);
    try {
      const a = await setActiveWorkspace(id);
      setActive(a);
      onWorkspaceContextChange({ connected: true, active: a });
    } catch (err) {
      setWsError((err as Error).message);
    }
  };

  useEffect(() => {
    resolveWorkspace().catch(() => {});
    // Re-runs on mount AND whenever reloadSignal changes (a workspace was
    // created/linked/unlinked elsewhere), so the bar never stays stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const refreshSession = async () => {
    const cfg = await getCloudConfig();
    setConfig(cfg);
    if (!cfg.enabled) return;
    const sess = await getCloudSession();
    setSession(sess);
    await resolveWorkspace();
  };

  useEffect(() => {
    refreshSession().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep-link round trip (ADR 0014): the Rust shell forwards a promptconnext://
  // callback here as `{ url }`; we pull code/state off the query string and
  // redeem it against the engine. Under the enforced gate the App-level AuthGate
  // owns first sign-in, but this keeps in-app re-auth working in relaxed mode.
  useEffect(() => {
    const unlisten = listen<{ url: string }>("auth-callback", async (event) => {
      try {
        const url = new URL(event.payload.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return;
        await redeemBrowserLogin(code, state);
        setWaiting(false);
        await refreshSession();
      } catch (err) {
        setWaiting(false);
        setAcctError((err as Error).message);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginBrowserLogin = async () => {
    setAcctError(null);
    setWaiting(true);
    try {
      const { url } = await startBrowserLogin();
      await openUrl(url);
    } catch (err) {
      setWaiting(false);
      setAcctError((err as Error).message);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setAcctError(null);
    try {
      await cloudLogout();
      await refreshSession();
      // Drop straight to the auth gate under the enforced membership gate
      // (ADR 0015) instead of leaving a stale signed-in shell mounted.
      onGateRecheck?.();
    } catch (err) {
      setAcctError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitStubLogin = async () => {
    setBusy(true);
    setAcctError(null);
    try {
      await cloudLogin({ userId: userId.trim() });
      setUserId("");
      await refreshSession();
    } catch (err) {
      setAcctError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    if (!newName.trim()) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      await onCreateProject(newName.trim());
      setNewName("");
      setCreating(false);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreateBusy(false);
    }
  };

  const workspaceLabel = !connected
    ? "Local workspace"
    : active
      ? active.name
      : workspaces.length === 0
        ? "No cloud workspace yet"
        : "Choose a workspace";

  // A new project must be born into an active workspace once a cloud identity
  // is in play (ADR 0015 §5). Reflect that in the UI — disable creation until a
  // workspace is chosen — rather than surfacing the engine's 400 after the fact.
  const canCreateProject = !connected || Boolean(active);

  return (
    <header className="top-bar">
      <div className="tb-workspace">
        <span className="workspace-dot" aria-hidden="true" />
        <div className="tb-workspace-body">
          <span className="tb-workspace-name">{workspaceLabel}</span>
          {connected && workspaces.length > 1 && (
            <select
              className="tb-workspace-select"
              value={active?.id ?? ""}
              onChange={(e) => e.target.value && selectWorkspace(e.target.value)}
            >
              {!active && <option value="">Select…</option>}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {wsError && <p className="error tb-inline-error">{wsError}</p>}
      </div>

      <nav className="tb-projects">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"tb-tab" + (t.key === activeTabKey ? " active" : "")}
            onClick={() => onSelectTab(t.key)}
          >
            {t.name}
          </button>
        ))}
        {!canCreateProject ? (
          <span className="tb-tab tb-tab-muted" title="Choose a workspace first">
            + New project
          </span>
        ) : creating ? (
          <span className="tb-new-form">
            <input
              autoFocus
              value={newName}
              placeholder="Project name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreate();
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
            <button type="button" disabled={createBusy || !newName.trim()} onClick={submitCreate}>
              Add
            </button>
            {createError && <span className="error tb-inline-error">{createError}</span>}
          </span>
        ) : (
          <button type="button" className="tb-tab tb-tab-new" onClick={() => setCreating(true)}>
            + New project
          </button>
        )}
      </nav>

      <div className="tb-account">
        {!config?.enabled ? null : !session?.connected ? (
          config.mode === "supabase" ? (
            <button type="button" disabled={waiting} onClick={beginBrowserLogin}>
              {waiting ? "Waiting for browser…" : "Sign in"}
            </button>
          ) : (
            <span className="tb-stub-login" title="Dev cloud backend (AUTH_MODE=stub) — type any name to simulate a user, no real account">
              <input
                value={userId}
                placeholder="dev user (any name)"
                onChange={(e) => setUserId(e.target.value)}
              />
              <button type="button" disabled={busy || !userId.trim()} onClick={submitStubLogin}>
                Simulate sign-in
              </button>
            </span>
          )
        ) : (
          <span className="tb-account-body">
            <span className="tb-account-name">{session.userId}</span>
            <button type="button" className="link" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </span>
        )}
        {acctError && <p className="error tb-inline-error">{acctError}</p>}
      </div>
    </header>
  );
}
