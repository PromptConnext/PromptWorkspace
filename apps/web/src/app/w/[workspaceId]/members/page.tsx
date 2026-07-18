"use client";

import Link from "next/link";
import { use } from "react";
import { InviteForm } from "@/components/InviteForm";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Workspace, WorkspaceMember } from "@/lib/types";

function MembersView({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const { data: workspace } = useCloudGet<Workspace>(`/workspaces/${workspaceId}`);
  const { data: members, refetch: refetchMembers } = useCloudGet<WorkspaceMember[]>(
    `/workspaces/${workspaceId}/members`,
  );
  const isAdmin = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspace?.name ?? workspaceId, href: `/w/${workspaceId}` },
          { label: "Members" },
        ]}
      />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold">Members</h1>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-medium text-slate-500">People</h2>
          <ul className="flex flex-col gap-2">
            {members?.map((m) => (
              <li
                key={m.user_id}
                className="flex items-center justify-between rounded border border-slate-200 bg-white px-4 py-3"
              >
                <span className="font-medium">{m.user_id}</span>
                <span className="text-sm text-slate-500">{m.role}</span>
              </li>
            ))}
          </ul>
        </section>

        {isAdmin && (
          <>
            <InviteForm workspaceId={workspaceId} onInvited={refetchMembers} />
            {/* Task 3 mounts <PendingInvitations> here */}
          </>
        )}
        <Link href={`/w/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-900">
          ← Back to workspace
        </Link>
      </main>
    </>
  );
}

export default function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <MembersView workspaceId={workspaceId} />
    </RequireAuth>
  );
}
