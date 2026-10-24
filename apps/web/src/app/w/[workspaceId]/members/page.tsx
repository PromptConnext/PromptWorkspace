"use client";

import Link from "next/link";
import { use, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { DisplayNameField } from "@/components/DisplayNameField";
import { InviteForm } from "@/components/InviteForm";
import { PendingInvitations } from "@/components/PendingInvitations";
import { RequireAuth } from "@/components/RequireAuth";
import { RoleBadge } from "@/components/RoleBadge";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { displayName } from "@/lib/identity";
import { useWorkspaceName } from "@/lib/workspace";
import type { WorkspaceMember } from "@/lib/types";

function MembersView({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: members, refetch } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const isAdmin = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");
  const [editing, setEditing] = useState<string | null>(null);
  const me = members?.find((m) => m.user_id === user?.id);
  const refetchInvitesRef = useRef<() => void>(() => {});

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceName, href: `/w/${workspaceId}` },
          { label: "Members" },
        ]}
      />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Link
          href={`/w/${workspaceId}`}
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
        >
          ← {workspaceName}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Members</h1>
        <p className="mt-1 mb-8 text-sm text-slate-500">
          {members?.length ?? 0} {members?.length === 1 ? "person has" : "people have"} access to
          this workspace.
        </p>

        {me && (
          <div className="mb-6">
            <DisplayNameField
              key={me.display_name ?? ""}
              workspaceId={workspaceId}
              member={me}
              label="Your name"
              onSaved={() => refetch()}
            />
          </div>
        )}

        <section className="mb-10 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {members?.map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 px-4 py-3">
                <Avatar identity={m} />
                {editing === m.user_id ? (
                  <div className="min-w-0 flex-1">
                    <DisplayNameField
                      workspaceId={workspaceId}
                      member={m}
                      label="Name"
                      onSaved={() => {
                        setEditing(null);
                        refetch();
                      }}
                    />
                  </div>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-900">
                    {displayName(m)}
                  </span>
                )}
                {isAdmin && editing !== m.user_id && (
                  <button
                    type="button"
                    aria-label={`Edit name of ${displayName(m)}`}
                    onClick={() => setEditing(m.user_id)}
                    className="text-slate-400 hover:text-slate-900"
                  >
                    ✎
                  </button>
                )}
                <RoleBadge role={m.role} />
              </li>
            ))}
          </ul>
        </section>

        {isAdmin && (
          <>
            <InviteForm
              workspaceId={workspaceId}
              onInvited={() => refetchInvitesRef.current()}
            />
            <PendingInvitations
              workspaceId={workspaceId}
              registerRefetch={(fn) => {
                refetchInvitesRef.current = fn;
              }}
            />
          </>
        )}
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
