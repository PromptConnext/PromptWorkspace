import { useState } from "react";
import { deleteModelConnection, type Connection } from "../api";

// Visible list + explicit disconnect for connected models (plan §7f). Today
// reconnecting a role silently supersedes the prior secret with no way to see
// what's connected or drop one on purpose — this surfaces the list ThreeS
// already fetches via listModels() and adds a Disconnect action per row.
export default function ConnectedModels({
  connections,
  onChanged,
}: {
  connections: Connection[];
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (connections.length === 0) return null;

  const disconnect = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await deleteModelConnection(id);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="connected-models">
      <div className="agent-picker-head">
        <strong>Connected models</strong>
      </div>
      <ul className="connection-list">
        {connections.map((conn) => (
          <li key={conn.id}>
            <span>
              <span className="badge">{conn.role}</span> {conn.provider} · {conn.model}{" "}
              <span className={`badge ${conn.healthy ? "done" : ""}`}>
                {conn.healthy ? "connected" : "disconnected"}
              </span>
            </span>
            <button
              type="button"
              disabled={busyId === conn.id}
              onClick={() => disconnect(conn.id)}
            >
              {busyId === conn.id ? "Disconnecting…" : "Disconnect"}
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
