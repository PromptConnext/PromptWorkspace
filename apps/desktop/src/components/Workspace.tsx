import { useEffect, useState } from "react";
import { createProject, listProjects, type Project } from "../api";
import ThreeS from "./ThreeS";
import CloudConnect from "./CloudConnect";
import WorkspaceBar from "./WorkspaceBar";

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [sessionTick, setSessionTick] = useState(0);

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

  const inActive = activeWorkspaceId
    ? projects.filter((p) => p.cloud_workspace_id === activeWorkspaceId)
    : [];
  const unassigned = projects.filter((p) => p.cloud_workspace_id === null);
  const grouped = activeWorkspaceId !== null;

  const renderProject = (p: Project) => (
    <li key={p.id}>
      <button
        type="button"
        className={active?.id === p.id ? "active" : ""}
        onClick={() => setActive(p)}
      >
        {p.name}
      </button>
    </li>
  );

  return (
    <div className="workspace">
      <aside>
        <WorkspaceBar
          reloadSignal={sessionTick}
          onActiveChange={(id) => {
            setActiveWorkspaceId(id);
            void refresh();
          }}
        />
        <h2>Projects</h2>
        {grouped ? (
          <>
            <ul className="projects">{inActive.map(renderProject)}</ul>
            {unassigned.length > 0 && (
              <>
                <h3 className="muted">Local / unassigned</h3>
                <ul className="projects">{unassigned.map(renderProject)}</ul>
              </>
            )}
          </>
        ) : (
          <ul className="projects">{projects.map(renderProject)}</ul>
        )}
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
        {active && (
          <CloudConnect
            key={active.id}
            projectId={active.id}
            onSessionChange={() => setSessionTick((t) => t + 1)}
          />
        )}
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
