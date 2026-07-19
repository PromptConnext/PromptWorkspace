import { useEffect, useState } from "react";
import {
  createCloudWorkspace,
  getCloudConfig,
  getCloudLink,
  getCloudSession,
  getCloudSyncStatus,
  linkProjectToCloud,
  listCloudWorkspaces,
  triggerCloudSync,
  unlinkProjectFromCloud,
  type CloudConfig,
  type CloudLink,
  type CloudSession,
  type CloudSyncResult,
  type CloudWorkspace,
} from "../api";

// D1 (docs/plans/0004): opt-in "link this project to a workspace" panel.
// Renders nothing when cloud sync isn't configured server-side (CLOUD_API_URL
// unset) — most desktop users today are single-player. Account sign-in/out
// lives in the top bar now; this only ever links/unlinks the open project.
export default function CloudConnect({
  projectId,
  onChange,
}: {
  projectId: string;
  onChange?: () => void;
}) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [link, setLink] = useState<CloudLink | null>(null);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [pickedWorkspace, setPickedWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<CloudSyncResult | null>(null);

  const refresh = async () => {
    const cfg = await getCloudConfig();
    setConfig(cfg);
    if (!cfg.enabled) return;
    const sess = await getCloudSession();
    setSession(sess);
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

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      onChange?.();
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
        <p className="muted">Sign in from the top bar to link this project to a workspace.</p>
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
        Signed in as <strong>{session.email ?? session.userId}</strong>. Link this project to a workspace to
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
      {error && <p className="error">{error}</p>}
    </div>
  );
}
