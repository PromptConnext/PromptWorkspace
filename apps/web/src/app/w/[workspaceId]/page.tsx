"use client";

import Link from "next/link";
import { use } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useCloudGet } from "@/lib/hooks";
import type { Project, Workspace, WorkspaceMember } from "@/lib/types";

function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
  const { data: workspace } = useCloudGet<Workspace>(`/workspaces/${workspaceId}`);
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const { data: allProjects, error, loading } = useCloudGet<Project[]>("/projects");
  const projects = allProjects?.filter((p) => p.workspace_id === workspaceId) ?? [];

  return (
    <>
      <TopBar crumbs={[{ label: workspace?.name ?? workspaceId }]} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-xl font-semibold">{workspace?.name ?? "Workspace"}</h1>
          <p className="text-sm text-slate-500">{members?.length ?? 0} member(s)</p>
        </div>

        {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && projects.length === 0 && (
          <p className="text-sm text-slate-500">
            No projects yet in this workspace. Link one from the desktop app.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/w/${workspaceId}/p/${p.id}`}
                className="block rounded border border-slate-200 bg-white px-4 py-3 hover:border-slate-400"
              >
                <span className="font-medium">{p.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}

export default function WorkspacePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <WorkspaceHome workspaceId={workspaceId} />
    </RequireAuth>
  );
}
