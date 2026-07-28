"use client";

import Link from "next/link";
import { use } from "react";
import { GithubInstallForm } from "@/components/GithubInstallForm";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Workspace, WorkspaceMember } from "@/lib/types";

function SettingsView({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const { data: workspace, refetch: refetchWorkspace } = useCloudGet<Workspace>(
    `/workspaces/${workspaceId}`,
  );
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const isAdmin = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspace?.name ?? workspaceId, href: `/w/${workspaceId}` },
          { label: "Settings" },
        ]}
      />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href={`/w/${workspaceId}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          ← {workspace?.name ?? "Workspace"}
        </Link>
        <h1 className="mb-8 text-2xl font-semibold tracking-tight text-slate-900">
          Workspace settings
        </h1>

        {isAdmin && (
          <GithubInstallForm workspaceId={workspaceId} onInstalled={refetchWorkspace} />
        )}
      </main>
    </>
  );
}

export default function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <SettingsView workspaceId={workspaceId} />
    </RequireAuth>
  );
}
