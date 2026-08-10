import { useCallback, useEffect, useRef, useState } from "react";
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
  type Project,
} from "../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/Select";

export type WorkspaceContext = {
  connected: boolean;
  active: ActiveWorkspace | null;
};

// A navigable project tab. `key` encodes the source: `cloud:<cloudProjectId>`
// for a roster project (resolved to a local project on select) or
// `local:<localProjectId>` for a purely-local / pending-sync one. Workspace
// owns the roster-driven tab list (ADR 0015 G3); TopBar just renders it.
// `lifecycle_status`/`repo_url` are carried along only for cloud tabs that
// have no local counterpart yet, so TopBar can render a muted badge for the
// three pre-repo states instead of a project name alone (plan: cloud creates
// the repo at tech-review exit).
export type ProjectTab = {
  key: string;
  name: string;
  lifecycle_status?: string;
  repo_url?: string | null;
};

// Muted, human-readable label for a cloud tab not yet at repo_created.
// Undefined (no badge) once the repo exists — a project tab reads as a plain
// name from then on, matching a local project's tab.
function lifecycleBadge(status?: string): string | null {
  switch (status) {
    case "planning":
      return "In planning";
    case "pending_tech_review":
      return "Awaiting review";
    case "tech_review":
      return "In tech review";
    default:
      return null;
  }
}

// Why the Planner button is unavailable, in the user's terms. A pre-repo cloud
// project *is* selected — saying "select a project first" there reads as a bug,
// so name the real blocker and point at the surface that does work today: the
// cloud Planner authors the plan until tech-review exit creates the repo
// (ADR 0017), and only then is there a local checkout for this button to open.
function plannerBlockedReason(status?: string): string {
  switch (status) {
    case "planning":
    case "pending_tech_review":
    case "tech_review":
      return "Repository not created yet — plan this project in the cloud Planner";
    case "repo_created":
      // Selected, repo exists, but no local checkout on this machine yet — the
      // folder-picker panel below is the next step, not tab selection.
      return "Open this project on your machine first";
    default:
      return "Select a project first";
  }
}

// Global navigation shell (replaces the old sidebar project list): one bar
// always visible above the 3S flow, so switching workspace/project or seeing
// who's signed in never requires leaving the current project. Three zones —
// workspace switcher, project tabs, account status — read left to right as
// "where am I, what's in it, who am I".
export default function TopBar({
  tabs,
  activeTabKey,
  activeProject,
  onSelectTab,
  onCreateProject,
  reloadSignal,
  onWorkspaceContextChange,
  onGateRecheck,
  onOpenPlanner,
}: {
  tabs: ProjectTab[];
  activeTabKey: string | null;
  activeProject: Project | null;
  onSelectTab: (key: string) => void;
  onCreateProject: (name: string) => Promise<void>;
  reloadSignal: number;
  onWorkspaceContextChange: (ctx: WorkspaceContext) => void;
  onGateRecheck?: () => void;
  onOpenPlanner: () => void;
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
  // Manual fallback for the ADR 0014 browser handoff: the promptconnext://
  // redirect relies on the OS having a registered handler for the scheme,
  // which macOS only sets up for a bundled+installed .app (Info.plist) — an
  // unbundled `tauri dev` binary has no such registration and the browser
  // just sits on the cloud app after sign-in with no way back. `pendingState`
  // is the state startBrowserLogin() minted, needed to redeem a manually
  // pasted code.
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [showManualCode, setShowManualCode] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  // Tab strip overflow state. More projects than fit is the normal case, so the
  // strip scrolls — but a plain `overflow-x: auto` leaves a chip sliced in half
  // at the edge, which reads as a rendering bug rather than "there's more this
  // way". Edge fades mark the hidden direction, and snap alignment (CSS) keeps
  // scrolling from ever resting mid-chip.
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const syncOverflow = useCallback(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    syncOverflow();
    const el = tabStripRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(syncOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length, syncOverflow]);

  // Selecting a project elsewhere (roster refresh, deep link) can leave its tab
  // parked outside the visible window; pull it back in.
  useEffect(() => {
    const el = tabStripRef.current?.querySelector<HTMLElement>(".tb-tab.active");
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabKey, tabs.length]);

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

  // A transient listCloudWorkspaces() failure at startup (no active workspace
  // stored yet to fall back on) permanently mislabels this as "no cloud
  // workspace yet" — same failure class Workspace.tsx already guards its
  // roster fetch against with a focus retry (ADR 0015 §2: refresh on
  // sign-in/focus/explicit refresh). Mirror that here so a cold-start network
  // blip self-heals instead of sticking until something else bumps reloadSignal.
  useEffect(() => {
    const onFocus = () => {
      resolveWorkspace().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setShowManualCode(false);
    setManualCode("");
    try {
      const { url, state } = await startBrowserLogin();
      setPendingState(state);
      await openUrl(url);
    } catch (err) {
      setWaiting(false);
      setAcctError((err as Error).message);
    }
  };

  const submitManualCode = async () => {
    if (!manualCode.trim() || !pendingState) return;
    setAcctError(null);
    try {
      await redeemBrowserLogin(manualCode.trim(), pendingState);
      setWaiting(false);
      setShowManualCode(false);
      setManualCode("");
      setPendingState(null);
      await refreshSession();
    } catch (err) {
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

  // Only the active project's own cloud page — no workspace-level link, no
  // sub-tab deep link (spec: out of scope). Absent whenever the open project
  // isn't linked yet, or config hasn't loaded.
  const cloudProjectLink =
    config?.webUrl && activeProject?.cloud_workspace_id && activeProject?.cloud_project_id
      ? `${config.webUrl}/w/${activeProject.cloud_workspace_id}/p/${activeProject.cloud_project_id}`
      : null;

  const openInCloud = async () => {
    if (!cloudProjectLink) return;
    try {
      await openUrl(cloudProjectLink);
    } catch (err) {
      setAcctError((err as Error).message);
    }
  };

  return (
    <header className="top-bar">
      <div className="tb-workspace">
        <span className="workspace-dot" aria-hidden="true" />
        <div className="tb-workspace-body">
          {/* The switcher already shows the active workspace's name — printing
              it again beside the select was the same string twice in a row. */}
          {connected && workspaces.length > 1 ? (
            <Select value={active?.id ?? ""} onValueChange={selectWorkspace}>
              {/* The blank "Choose a workspace…" entry is a placeholder now:
                  Radix keeps the empty value for "nothing selected" and won't
                  accept it on an item, which also means onValueChange can no
                  longer hand back the "" the old handler guarded against. */}
              <SelectTrigger
                className="tb-workspace-select"
                title="Switch workspace"
                aria-label="Switch workspace"
              >
                <SelectValue placeholder="Choose a workspace…" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="tb-workspace-name" title={workspaceLabel}>
              {workspaceLabel}
            </span>
          )}
        </div>
        {wsError && <p className="error tb-inline-error">{wsError}</p>}
      </div>

      <div className="tb-projects">
        {/* Only the tab list scrolls. "New project" and the cloud link live
            outside it so a long project list can never push them off-screen. */}
        <nav
          className={
            "tb-tabs" +
            (overflow.start ? " tb-tabs-fade-start" : "") +
            (overflow.end ? " tb-tabs-fade-end" : "")
          }
          ref={tabStripRef}
          onScroll={syncOverflow}
        >
          {tabs.map((t) => {
            const badge = lifecycleBadge(t.lifecycle_status);
            return (
              <button
                key={t.key}
                type="button"
                className={"tb-tab" + (t.key === activeTabKey ? " active" : "")}
                title={badge ? `${t.name} — ${badge}` : t.name}
                onClick={() => onSelectTab(t.key)}
              >
                <span className="tb-tab-name">{t.name}</span>
                {badge && <span className="tb-tab-badge">{badge}</span>}
              </button>
            );
          })}
        </nav>

        <div className="tb-projects-actions">
          {cloudProjectLink && (
            <button
              type="button"
              className="tb-cloud-link"
              title={`Open "${activeProject?.name}" in the cloud`}
              onClick={openInCloud}
            >
              ↗ Cloud
            </button>
          )}
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
        </div>
      </div>

      <button
        type="button"
        className={"tb-planner" + (activeProject ? "" : " tb-planner-muted")}
        disabled={!activeProject}
        title={
          activeProject
            ? "Open Planner"
            : plannerBlockedReason(tabs.find((t) => t.key === activeTabKey)?.lifecycle_status)
        }
        onClick={onOpenPlanner}
      >
        ✦ Planner
      </button>

      <div className="tb-account">
        {!config?.enabled ? null : !session?.connected ? (
          config.mode === "supabase" ? (
            <span className="tb-browser-login">
              <button type="button" disabled={waiting} onClick={beginBrowserLogin}>
                {waiting ? "Waiting for browser…" : "Sign in"}
              </button>
              {waiting && !showManualCode && (
                <button type="button" className="link" onClick={() => setShowManualCode(true)}>
                  Didn&apos;t redirect? Paste code
                </button>
              )}
              {waiting && showManualCode && (
                <span className="tb-manual-code">
                  <input
                    autoFocus
                    value={manualCode}
                    placeholder="Code from the browser"
                    onChange={(e) => setManualCode(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitManualCode()}
                  />
                  <button type="button" disabled={!manualCode.trim()} onClick={submitManualCode}>
                    Submit
                  </button>
                </span>
              )}
            </span>
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
            <span className="tb-account-name">{session.email ?? session.userId}</span>
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
