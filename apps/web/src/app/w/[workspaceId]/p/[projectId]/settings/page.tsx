"use client";

import Link from "next/link";
import { use } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { ProjectRolesPanel } from "@/components/project/ProjectRolesPanel";
import { ReindexPanel } from "@/components/project/ReindexPanel";
import { useCloudGet } from "@/lib/hooks";
import { useIsWorkspaceAdmin, useWorkspaceName } from "@/lib/workspace";
import type { ProjectGraph } from "@/lib/types";

function ProjectSettingsView({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: graph } = useCloudGet<ProjectGraph>(`/sync/projects/${projectId}/graph`);
  const isAdmin = useIsWorkspaceAdmin(workspaceId);

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceName, href: `/w/${workspaceId}` },
          { label: graph?.project.name ?? "Project", href: `/w/${workspaceId}/p/${projectId}` },
          { label: "Settings" },
        ]}
      />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href={`/w/${workspaceId}/p/${projectId}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          ← {graph?.project.name ?? "Project"}
        </Link>
        <h1 className="mb-8 text-2xl font-semibold tracking-tight text-slate-900">
          Project settings
        </h1>

        <ProjectRolesPanel projectId={projectId} workspaceId={workspaceId} isAdmin={isAdmin} />
        {isAdmin && <ReindexPanel projectId={projectId} />}
      </main>
    </>
  );
}

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = use(params);
  return (
    <RequireAuth>
      <ProjectSettingsView workspaceId={workspaceId} projectId={projectId} />
    </RequireAuth>
  );
}
