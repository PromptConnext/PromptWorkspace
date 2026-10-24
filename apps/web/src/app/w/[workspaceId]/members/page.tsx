"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { DisplayNameField } from "@/components/DisplayNameField";
import { InviteForm } from "@/components/InviteForm";
import { PendingInvitations } from "@/components/PendingInvitations";
import { RequireAuth } from "@/components/RequireAuth";
import { RoleBadge } from "@/components/RoleBadge";
import { TopBar } from "@/components/TopBar";
import { MemberPanel } from "@/components/workspace/MemberPanel";
import { useOverview } from "@/components/workspace/useOverview";
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
  const { data: overview } = useOverview(workspaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedMember = members?.find((m) => m.user_id === selected);
  const showPanel = !!selectedMember && !!overview && !!user;
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  const refetchInvitesRef = useRef<() => void>(() => {});

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceName, href: `/w/${workspaceId}` },
          { label: "Members" },
        ]}
      />
      <main className={`mx-auto px-4 py-10 ${showPanel ? "max-w-5xl" : "max-w-2xl"}`}>
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
              workspaceId={workspaceId}
              member={me}
              label="Your name"
              onSaved={() => refetch()}
            />
          </div>
        )}

        <div className={showPanel ? "mb-10 grid gap-6 md:grid-cols-[1fr_minmax(0,22rem)] md:items-start" : "mb-10"}>
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <ul className="divide-y divide-slate-100">
            {members?.map((m) => (
              <li
                key={m.user_id}
                className={`flex items-center gap-3 px-4 py-3 ${selected === m.user_id ? "bg-slate-50" : ""}`}
              >
                <Avatar identity={m} />
                {editing === m.user_id ? (
                  <div className="min-w-0 flex-1">
                    <DisplayNameField
                      workspaceId={workspaceId}
                      member={m}
                      label="Name"
                      onSaved={() => refetch()}
                    />
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="mt-1 text-xs text-slate-500 hover:text-slate-900"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-pressed={selected === m.user_id}
                    aria-label={`${selected === m.user_id ? "Hide" : "Show"} details for ${displayName(m)}`}
                    onClick={() => setSelected(selected === m.user_id ? null : m.user_id)}
                    className="min-w-0 flex-1 truncate text-left font-medium text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-900"
                  >
                    {displayName(m)}
                  </button>
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
        {showPanel && (
          <MemberPanel
            key={selectedMember.user_id}
            member={selectedMember}
            overview={overview}
            viewerIsAdmin={isAdmin}
            viewerId={user.id}
            workspaceId={workspaceId}
          />
        )}
        </div>

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
