"use client";

import Link from "next/link";
import { use } from "react";
import { GithubConnectionForm } from "@/components/GithubConnectionForm";
import { ModelConnectionForm } from "@/components/ModelConnectionForm";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useIsWorkspaceAdmin, useWorkspaceName } from "@/lib/workspace";

function SettingsView({ workspaceId }: { workspaceId: string }) {
  const workspaceName = useWorkspaceName(workspaceId);
  const isAdmin = useIsWorkspaceAdmin(workspaceId);

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceName, href: `/w/${workspaceId}` },
          { label: "Settings" },
        ]}
      />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href={`/w/${workspaceId}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          ← {workspaceName}
        </Link>
        <h1 className="mb-8 text-2xl font-semibold tracking-tight text-slate-900">
          Workspace settings
        </h1>

        {isAdmin && (
          <>
            <GithubConnectionForm workspaceId={workspaceId} />
            <ModelConnectionForm workspaceId={workspaceId} />
          </>
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
