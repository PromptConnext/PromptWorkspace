import { useEffect, useState } from "react";
import {
  getActiveWorkspace,
  getCloudSession,
  listCloudWorkspaces,
  setActiveWorkspace,
  type ActiveWorkspace,
  type CloudWorkspace,
} from "../api";

// Resolves and displays the active cloud workspace once the app is connected to
// cloud. Local-only (not connected) → renders nothing, desktop is unchanged.
// remember-last → auto-enter single → picker for many.
export default function WorkspaceBar({
  onActiveChange,
  reloadSignal,
}: {
  onActiveChange: (id: string | null) => void;
  reloadSignal: number;
}) {
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [active, setActive] = useState<ActiveWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async () => {
    const session = await getCloudSession();
    if (!session.connected) {
      // Logged out (or never logged in): clear all local state so the
      // project list falls back to a flat, unfiltered, local-first view.
      setConnected(false);
      setActive(null);
      setWorkspaces([]);
      onActiveChange(null);
      return;
    }
    setConnected(true);
    const stored = await getActiveWorkspace().catch(() => null);
    let ws: CloudWorkspace[];
    try {
      ws = (await listCloudWorkspaces()).workspaces;
    } catch {
      // Cloud is unreachable — this is NOT the same as "no workspaces".
      // Keep whatever workspace was previously remembered/active instead of
      // dropping to the "no workspaces" picker.
      if (stored) {
        setActive(stored);
        onActiveChange(stored.id);
        return;
      }
      setWorkspaces([]);
      setActive(null);
      onActiveChange(null);
      return;
    }
    setWorkspaces(ws);
    // remember-last: stored active still a membership?
    if (stored && ws.some((w) => w.id === stored.id)) {
      setActive(stored);
      onActiveChange(stored.id);
      return;
    }
    // auto-enter a single membership
    if (ws.length === 1) {
      await select(ws[0].id);
      return;
    }
    // else: leave unset -> picker renders below
    setActive(null);
    onActiveChange(null);
  };

  const select = async (id: string) => {
    setError(null);
    try {
      const a = await setActiveWorkspace(id);
      setActive(a);
      onActiveChange(a.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    resolve().catch(() => {});
    // Re-runs on mount AND whenever reloadSignal changes (cloud session
    // login/logout, signaled by the parent via CloudConnect's
    // onSessionChange), so the bar never stays inert after a session flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  if (!connected) return null;

  return (
    <div className="workspace-bar">
      {active ? (
        <label>
          Workspace
          <select value={active.id} onChange={(e) => select(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      ) : workspaces.length === 0 ? (
        <p className="muted">No cloud workspaces yet. Create one below to start syncing.</p>
      ) : (
        <label>
          Select a workspace
          <select value="" onChange={(e) => e.target.value && select(e.target.value)}>
            <option value="">Choose…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
