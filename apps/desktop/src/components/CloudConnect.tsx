import { useEffect, useState } from "react";
import {
  cloudLogin,
  cloudLogout,
  createCloudWorkspace,
  getCloudConfig,
  getCloudLink,
  getCloudSession,
  linkProjectToCloud,
  listCloudWorkspaces,
  unlinkProjectFromCloud,
  type CloudConfig,
  type CloudLink,
  type CloudSession,
  type CloudWorkspace,
} from "../api";

// D1 (docs/plans/0004): opt-in "Connect to PromptZone Cloud" panel per
// project. Renders nothing when cloud sync isn't configured server-side
// (CLOUD_API_URL unset) — most desktop users today are single-player.
export default function CloudConnect({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [link, setLink] = useState<CloudLink | null>(null);
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[]>([]);
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [pickedWorkspace, setPickedWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <h3>Connect to PromptZone Cloud</h3>
        {config.mode === "supabase" ? (
          <>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !email.trim() || !password}
              onClick={() => run(() => cloudLogin({ email: email.trim(), password }))}
            >
              {busy ? "Signing in…" : "Sign in"}
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
        onClick={() => run(() => linkProjectToCloud(projectId, pickedWorkspace))}
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
