import { useEffect, useState } from "react";
import { getProjectAgent, listAgents, setProjectAgent, type AgentInfo } from "../api";

// Choose which external coding agent runs implementation (ADR 0009). PromptZone
// orchestrates the agent the developer already uses; it doesn't ship its own.
export default function AgentPicker({ projectId }: { projectId: string }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selected, setSelected] = useState("auto");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([listAgents(), getProjectAgent(projectId)])
      .then(([a, s]) => {
        setAgents(a.agents);
        setSelected(s.selected);
      })
      .catch(() => {});
  }, [projectId]);

  const choose = async (id: string) => {
    setSelected(id);
    setSaving(true);
    try {
      await setProjectAgent(projectId, id);
    } finally {
      setSaving(false);
    }
  };

  const installed = agents.filter((a) => a.installed);
  const absent = agents.filter((a) => !a.installed && a.id !== "custom");

  return (
    <div className="agent-picker">
      <div className="agent-picker-head">
        <strong>Coding agent</strong>
        {saving && <span className="muted"> · saving…</span>}
      </div>
      <p className="muted">
        PromptZone runs the agent you already use — it ships none of its own. Pick which one
        implements tasks here.
      </p>
      <div className="agent-chips">
        <button
          type="button"
          className={`agent-chip ${selected === "auto" ? "active" : ""}`}
          onClick={() => choose("auto")}
        >
          Auto ({installed[0]?.label ?? "one-shot fallback"})
        </button>
        {installed.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`agent-chip ${selected === a.id ? "active" : ""}`}
            onClick={() => choose(a.id)}
          >
            {a.label}
            {a.bringsOwnModel ? " · own account" : " · your model"}
          </button>
        ))}
      </div>
      {installed.length === 0 && (
        <p className="muted">
          No agent CLI detected — the Run button uses the built-in one-shot fallback (needs a
          connected coding model).
        </p>
      )}
      {absent.length > 0 && (
        <p className="muted">
          Not installed: {absent.map((a) => a.label).join(", ")} — install its CLI to use it here.
        </p>
      )}
    </div>
  );
}
