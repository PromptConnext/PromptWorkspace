import type { Graph } from "../api";

// Read-only traceability view (roadmap Phase 1): requirement → spec → task,
// plus every agent run as evidence.
export default function GraphView({ graph }: { graph: Graph | null }) {
  if (!graph) return <p>Loading graph…</p>;
  return (
    <div className="graph">
      <ul className="tree">
        {graph.requirements.length === 0 && <li>No requirements yet — run Scope.</li>}
        {graph.requirements.map((req) => (
          <li key={req.id}>
            <strong>Requirement:</strong> {req.title}{" "}
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
                        {task.title} <span className={`badge ${task.status}`}>{task.status}</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
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
