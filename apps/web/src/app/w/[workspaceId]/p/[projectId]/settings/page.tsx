"use client";

import Link from "next/link";
import { use } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspaceName } from "@/lib/workspace";
import type { ProjectGraph, WorkspaceMember } from "@/lib/types";

function ProjectSettingsView({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { user } = useAuth();
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: graph } = useCloudGet<ProjectGraph>(`/sync/projects/${projectId}/graph`);
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const isAdmin = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

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
