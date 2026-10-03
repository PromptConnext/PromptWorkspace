import { useState } from "react";
import {
  linkProjectToCloud,
  triggerCloudSync,
  type Project,
  type RosterWorkspace,
} from "../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/Select";

// Migration affordance for existing installs (ADR 0015 §, plan 0006 G4). Under
// the membership gate, projects that were never linked to a workspace
// (`cloud_workspace_id === null`) are no longer shown as tabs — the roster is
// the authority for what's reachable. On first gated launch we surface a
// one-time "N local projects aren't in a workspace — import them?" prompt so a
// user can move each pre-existing local project into a workspace of their
// choosing (reusing linkProjectToCloud + sync). Nothing is auto-linked: the
// engine already refuses to silently push a private local project to a shared
// workspace, and declining here leaves each project local and simply
// unreachable under the gate until the user chooses to import it later.

const DISMISS_KEY = "promptworkspace.importLocalProjects.dismissed";

export default function ImportLocalProjects({
  localOnly,
  workspaces,
  onImported,
}: {
  localOnly: Project[];
  workspaces: RosterWorkspace[];
  onImported: () => void;
}) {
  // One-time: once dismissed, the prompt doesn't nag on every launch. It stays
  // reachable via a compact link (below) so "import later" still works without
  // clearing anything by hand.
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  );
  // Per-project chosen target workspace; defaults to the only workspace when
  // there's just one, so the common case is a single click.
  const soleWorkspace = workspaces.length === 1 ? workspaces[0].id : "";
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (localOnly.length === 0) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const reopen = () => {
    localStorage.removeItem(DISMISS_KEY);
    setDismissed(false);
  };

  const importProject = async (project: Project) => {
    const workspaceId = targets[project.id] || soleWorkspace;
    if (!workspaceId) return;
    setBusyId(project.id);
    setError(null);
    try {
      // Reuse today's link mechanism: this creates the cloud project in the
      // chosen workspace and records the per-project link, then a push flushes
      // the local graph up so the project appears on the roster.
      await linkProjectToCloud(project.id, workspaceId);
      await triggerCloudSync(project.id).catch(() => {});
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (dismissed) {
    return (
      <p className="import-hint muted">
        {localOnly.length} local {localOnly.length === 1 ? "project isn't" : "projects aren't"} in a
        workspace and won't appear until imported.{" "}
        <button type="button" className="link" onClick={reopen}>
          Import…
        </button>
      </p>
    );
  }

  return (
    <section className="import-panel">
      <div className="import-head">
        <strong>
          {localOnly.length} local {localOnly.length === 1 ? "project isn't" : "projects aren't"} in
          a workspace
        </strong>
        <button type="button" className="link" onClick={dismiss}>
          Not now
        </button>
      </div>
      <p className="muted">
        Import a project into a workspace to make it reachable and sync it to the cloud. Declining
        leaves it local and private on this machine — you can import it later.
      </p>
      <ul className="import-list">
        {localOnly.map((p) => (
          <li key={p.id} className="import-row">
            <span className="import-name">{p.name}</span>
            {workspaces.length > 1 && (
              <Select
                value={targets[p.id] ?? ""}
                onValueChange={(v) => setTargets((t) => ({ ...t, [p.id]: v }))}
              >
                <SelectTrigger className="import-select" aria-label={`Workspace for ${p.name}`}>
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
            )}
            <button
              type="button"
              disabled={busyId === p.id || !(targets[p.id] || soleWorkspace)}
              onClick={() => importProject(p)}
            >
              {busyId === p.id ? "Importing…" : "Import"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
