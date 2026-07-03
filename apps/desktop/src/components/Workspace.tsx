import { useEffect, useState } from "react";
import { createProject, listProjects, type Project } from "../api";
import ThreeS from "./ThreeS";

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    listProjects().then((r) => setProjects(r.projects)).catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    setError(null);
    try {
      const project = await createProject(name.trim());
      await refresh();
      setActive(project);
      setName("");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="workspace">
      <aside>
        <h2>Projects</h2>
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={active?.id === p.id ? "active" : ""}
                onClick={() => setActive(p)}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
        <div className="new-project">
          <input
            value={name}
            placeholder="New project name"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="button" disabled={!name.trim()} onClick={create}>
            Create
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </aside>
      <div className="content">
        {active ? (
          <ThreeS key={active.id} project={active} />
        ) : (
          <p className="muted">Select or create a project to start the 3S flow.</p>
        )}
      </div>
    </div>
  );
}
