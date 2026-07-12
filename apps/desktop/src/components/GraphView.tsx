import { useState } from "react";
import type { Graph } from "../api";
import DiscussionPanel from "./DiscussionPanel";

type Selected = { nodeType: string; nodeId: string; label: string };

// Traceability view (roadmap Phase 1): requirement → spec → task, plus every
// agent run as evidence. Read-only except for comments (M12) — clicking a
// requirement or task selects it and opens its discussion thread below.
export default function GraphView({ graph, projectId }: { graph: Graph | null; projectId: string }) {
  const [selected, setSelected] = useState<Selected | null>(null);

  if (!graph) return <p>Loading graph…</p>;
  return (
    <div className="graph">
      <ul className="tree">
        {graph.requirements.length === 0 && <li>No requirements yet — run Scope.</li>}
        {graph.requirements.map((req) => (
          <li key={req.id}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setSelected({ nodeType: "requirements", nodeId: req.id, label: req.title });
              }}
            >
              <strong>Requirement:</strong> {req.title}
            </a>{" "}
            <span className={`badge ${req.status}`}>{req.status}</span>
            <ul>
              {req.specDocuments.map((spec) => (
                <li key={spec.id}>
                  <strong>Spec v{spec.version}</strong>{" "}
                  {spec.approved_by ? (
                    <span className="badge approved">approved by {spec.approved_by}</span>
                  ) : (
                    <span className="badge draft">unapproved</span>
                  )}
                  <ul>
                    {spec.tasks.length === 0 && <li className="muted">No tasks yet</li>}
                    {spec.tasks.map((task) => (
                      <li key={task.id}>
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setSelected({ nodeType: "tasks", nodeId: task.id, label: task.title });
                          }}
                        >
                          {task.title}
                        </a>{" "}
                        <span className={`badge ${task.status}`}>{task.status}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {selected && (
        <DiscussionPanel
          projectId={projectId}
          nodeType={selected.nodeType}
          nodeId={selected.nodeId}
          label={selected.label}
        />
      )}
      <h3>Agent runs</h3>
      <table className="runs">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Status</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {graph.agentRuns.map((run) => (
            <tr key={run.id}>
              <td>{run.created_at}</td>
              <td>{run.action}</td>
              <td>
                <span className={`badge ${run.status}`}>{run.status}</span>
              </td>
              <td>{run.evidence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
