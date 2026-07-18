import { useState } from "react";
import { cloudLogout, createCloudWorkspace, refreshCloudRoster } from "../api";

// Membership gate (ADR 0015 state 2): signed in, zero workspaces. The 3S
// surface stays blocked until the user creates a workspace or accepts an
// invite. Invite acceptance stays in apps/web for v1 (ADR 0011 read-first
// posture), so this screen just points there. With G1's personal-workspace
// auto-provision shipped, this is a rare fallback (e.g. removed from every
// workspace), not the first-run default.
export default function NoWorkspace({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createCloudWorkspace(name.trim());
      // Refresh the cache so the new workspace is present before the gate
      // re-resolves; then hand back to App to move past the membership gate.
      await refreshCloudRoster().catch(() => {});
      setName("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await cloudLogout();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate">
      <h1>You're not in a workspace yet</h1>
      <p>
        Workspaces hold your projects and teammates. Create one to start the 3S
        flow, or accept a workspace invitation.
      </p>
      <div className="gate-form">
        <input
          value={name}
          placeholder="Workspace name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
        />
        <button type="button" disabled={busy || !name.trim()} onClick={create}>
          {busy ? "Creating…" : "Create workspace"}
        </button>
      </div>
      <p className="hint">
        Invited to a workspace? Accept the invitation in the PromptConnext web
        app, then return here — it appears on the next roster refresh.
      </p>
      <button type="button" className="link" disabled={busy} onClick={signOut}>
        Sign out
      </button>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
