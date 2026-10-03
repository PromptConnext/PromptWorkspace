import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createBackup, listBackups, type BackupInfo } from "../api";

// Local task-graph backup (pre-launch readiness review, Must Have #2). The
// engine's SQLite file is the offline source of truth (ADR 0003) and cloud
// sync is opt-in (ADR 0010), so a user who never signs in has exactly one copy
// of every requirement, spec and task they have written. This panel is the
// second copy — and, just as importantly, tells them where it went, since
// restoring means putting the file back by hand.

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export default function BackupPanel() {
  const [dir, setDir] = useState<string>("");
  const [dbPath, setDbPath] = useState<string>("");
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await listBackups();
      setDir(res.dir);
      setDbPath(res.db_path);
      setBackups(res.backups);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const backUpNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await createBackup();
      setJustCreated(info.path);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="backup-panel">
      <div className="agent-picker-head">
        <strong>Backups</strong>
      </div>
      <p className="hint">
        Your projects, specs and tasks live in a single database file on this machine. A backup
        copies it somewhere safe; to restore one, quit PromptWorkspace and put the file back at{" "}
        <code>{dbPath || "the database path"}</code>.
      </p>

      <button type="button" onClick={backUpNow} disabled={busy}>
        {busy ? "Backing up…" : "Back up now"}
      </button>

      {justCreated && (
        <p className="hint">
          Saved to <code>{justCreated}</code>
        </p>
      )}

      {backups.length > 0 && (
        <ul className="connection-list">
          {backups.map((b) => (
            <li key={b.path}>
              <span>
                {new Date(b.created_at).toLocaleString()} · {humanBytes(b.bytes)}
              </span>
              <button type="button" onClick={() => void revealItemInDir(b.path)}>
                Show in folder
              </button>
            </li>
          ))}
        </ul>
      )}

      {backups.length === 0 && !error && (
        <p className="hint">No backups yet. They will be written to <code>{dir}</code>.</p>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
