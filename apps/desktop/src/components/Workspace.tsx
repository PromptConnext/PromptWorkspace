import { useEffect, useState } from "react";
import { createProject, linkProjectToCloud, listProjects, type Project } from "../api";
import ThreeS from "./ThreeS";
import CloudConnect from "./CloudConnect";
import TopBar, { type WorkspaceContext } from "./TopBar";

export default function Workspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [active, setActive] = useState<Project | null>(null);
  const [workspaceCtx, setWorkspaceCtx] = useState<WorkspaceContext>({
    connected: false,
    active: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = () =>
    listProjects().then((r) => setProjects(r.projects)).catch(() => {});

  useEffect(() => {
    refresh();
  }, []);

  const create = async (name: string) => {
    const project = await createProject(name);
    // Best-effort: land the new project straight in the active workspace so
    // it never has to pass through an "unlinked" state in the common case.
    // A failure here still leaves a valid, usable local project — it just
    // needs linking later via the Cloud panel below.
    if (workspaceCtx.active) {
      await linkProjectToCloud(project.id, workspaceCtx.active.id).catch(() => {});
    }
    await refresh();
    setActive(project);
  };

  return (
    <div className="workspace">
      <TopBar
        projects={projects}
        activeProjectId={active?.id ?? null}
        onSelectProject={setActive}
        onCreateProject={create}
        reloadSignal={refreshTick}
        onWorkspaceContextChange={(ctx) => {
          setWorkspaceCtx(ctx);
          void refresh();
        }}
      />
      <div className="content">
        {active ? (
          <>
            <CloudConnect
              key={active.id}
              projectId={active.id}
              onChange={() => setRefreshTick((t) => t + 1)}
            />
            <ThreeS key={active.id} project={active} />
          </>
        ) : (
          <p className="muted">Select or create a project to start the 3S flow.</p>
        )}
      </div>
    </div>
  );
}
