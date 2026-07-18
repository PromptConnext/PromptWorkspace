import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  cloudLogin,
  cloudLogout,
  createCloudWorkspace,
  getCloudConfig,
  getCloudLink,
  getCloudSession,
  getCloudSyncStatus,
  linkProjectToCloud,
  listCloudWorkspaces,
  redeemBrowserLogin,
  startBrowserLogin,
  triggerCloudSync,
  unlinkProjectFromCloud,
  type CloudConfig,
  type CloudLink,
  type CloudSession,
  type CloudSyncResult,
  type CloudWorkspace,
} from "../api";

// D1 (docs/plans/0004): opt-in "Connect to PromptConnext Cloud" panel per
// project. Renders nothing when cloud sync isn't configured server-side
// (CLOUD_API_URL unset) — most desktop users today are single-player.
export default function CloudConnect({
  projectId,
  onSessionChange,
}: {
  projectId: string;
  onSessionChange?: () => void;
}) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [link, setLink] = useState<CloudLink | null>(null);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [userId, setUserId] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [pickedWorkspace, setPickedWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<CloudSyncResult | null>(null);

  const refresh = async () => {
    const cfg = await getCloudConfig();
    setConfig(cfg);
    if (!cfg.enabled) return;
    const sess = await getCloudSession();
    setSession(sess);
    // Notify any listener (e.g. the WorkspaceBar) that the cloud session may
    // have changed — covers login, logout, and the browser-redeem callback,
    // since all of them route through this refresh().
    onSessionChange?.();
    if (sess.connected) {
      const [ws, l] = await Promise.all([listCloudWorkspaces(), getCloudLink(projectId)]);
      setWorkspaces(ws.workspaces);
      setLink(l);
      if (l.linked) setSyncStatus(await getCloudSyncStatus(projectId).catch(() => null));
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Deep-link round trip (Task 5): the Rust shell forwards a
  // promptconnext:// callback here as `{ url }`, we pull code/state off the
  // query string and redeem it against the engine.
  useEffect(() => {
    const unlisten = listen<{ url: string }>("auth-callback", async (event) => {
      try {
        const url = new URL(event.payload.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) return;
        await redeemBrowserLogin(code, state);
        setWaiting(false);
        await refresh();
      } catch (err) {
        setWaiting(false);
        setError((err as Error).message);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginBrowserLogin = async () => {
    setError(null);
    setWaiting(true);
    try {
      const { url } = await startBrowserLogin();
      await openUrl(url);
    } catch (err) {
      setWaiting(false);
      setError((err as Error).message);
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!config?.enabled) return null;

  if (!session?.connected) {
    return (
      <div className="cloud-connect">
        <h3>Connect to PromptConnext Cloud</h3>
        {config.mode === "supabase" ? (
          <>
            <p className="muted">
              Sign in through your browser to connect this app to PromptConnext Cloud.
            </p>
            <button type="button" disabled={waiting} onClick={beginBrowserLogin}>
              {waiting ? "Waiting for browser…" : "Sign in with browser"}
            </button>
          </>
        ) : (
          <>
            <p className="muted">Cloud is running in dev/stub auth — enter any user id.</p>
            <label>
              User id
              <input value={userId} onChange={(e) => setUserId(e.target.value)} />
            </label>
            <button
              type="button"
              disabled={busy || !userId.trim()}
              onClick={() => run(() => cloudLogin({ userId: userId.trim() }))}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  if (link?.linked) {
    return (
      <div className="cloud-connect">
        <p className="muted">
          Synced to cloud workspace <strong>{link.workspace_id}</strong>
        </p>
        {syncStatus?.at && (
          <p className={syncStatus.ok ? "muted" : "error"}>
            {syncStatus.ok
              ? `Last synced ${new Date(syncStatus.at).toLocaleTimeString()}`
              : `Last sync failed: ${syncStatus.error}`}
          </p>
        )}
        <button type="button" disabled={busy} onClick={() => run(() => triggerCloudSync(projectId))}>
          {busy ? "Syncing…" : "Sync now"}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => unlinkProjectFromCloud(projectId))}>
          Unlink
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="cloud-connect">
      <p className="muted">
        Signed in as <strong>{session.userId}</strong>. Link this project to a workspace to
        start syncing.
      </p>
      {workspaces.length > 0 && (
        <label>
          Workspace
          <select value={pickedWorkspace} onChange={(e) => setPickedWorkspace(e.target.value)}>
            <option value="">Select…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        disabled={busy || !pickedWorkspace}
        onClick={() =>
          run(async () => {
            await linkProjectToCloud(projectId, pickedWorkspace);
            await triggerCloudSync(projectId);
          })
        }
      >
        Link project
      </button>
      <div className="new-workspace">
        <input
          value={newWorkspace}
          placeholder="New workspace name"
          onChange={(e) => setNewWorkspace(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !newWorkspace.trim()}
          onClick={() => run(() => createCloudWorkspace(newWorkspace.trim()))}
        >
          Create workspace
        </button>
      </div>
      <button type="button" className="link" disabled={busy} onClick={() => run(() => cloudLogout())}>
        Sign out
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
