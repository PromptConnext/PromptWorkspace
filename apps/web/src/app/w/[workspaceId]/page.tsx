"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { InboxLink } from "@/components/InboxLink";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { AskBox } from "@/components/workspace/AskBox";
import { ProjectCard } from "@/components/workspace/ProjectCard";
import { useOverview } from "@/components/workspace/useOverview";
import { useIsWorkspaceAdmin, useWorkspace, useWorkspaceName } from "@/lib/workspace";
import type { WorkspaceMember } from "@/lib/types";

const AVATAR_STACK_LIMIT = 4;

function MemberStack({ members }: { members: WorkspaceMember[] }) {
  const shown = members.slice(0, AVATAR_STACK_LIMIT);
  const overflow = members.length - shown.length;
  return (
    <span className="flex items-center">
      <span className="flex -space-x-2">
        {shown.map((m) => (
          <span key={m.user_id} className="ring-2 ring-white rounded-full">
            <Avatar identity={m} size="sm" />
          </span>
        ))}
      </span>
      {overflow > 0 && (
        <span className="ml-2 text-sm text-slate-500">+{overflow} more</span>
      )}
    </span>
  );
}

function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { memberships, loading: wsLoading, error: wsError, setActiveWorkspace } = useWorkspace();
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: overview, error, loading, refetch } = useOverview(workspaceId);
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
  const members = overview?.members;
  const projects = overview?.projects;

  const [creating, setCreating] = useState(false);

  // Treat visiting /w/{id} as an explicit selection: if it's a real membership,
  // make it the active workspace. Only bounce to the gate when memberships
  // loaded successfully and the id is genuinely NOT one — never on a transient
  // memberships-fetch error, which would otherwise discard a valid deep link.
  useEffect(() => {
    if (wsLoading) return;
    if (memberships.some((w) => w.id === workspaceId)) {
      setActiveWorkspace(workspaceId);
    } else if (!wsError) {
      router.replace("/");
    }
  }, [wsLoading, wsError, memberships, workspaceId, setActiveWorkspace, router]);

  return (
    <>
      <TopBar crumbs={[{ label: workspaceName }]} />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 break-words text-2xl font-semibold tracking-tight text-slate-900">
            {workspaceName}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
            >
              + New project
            </button>
            <Link
              href={`/w/${workspaceId}/members`}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300"
            >
              {members && members.length > 0 && <MemberStack members={members} />}
              <span className="text-sm text-slate-500">
                {members
                  ? `${members.length} ${members.length === 1 ? "member" : "members"}`
                  : "Members"}
              </span>
            </Link>
            <InboxLink workspaceId={workspaceId} />
            <Link
              href={`/w/${workspaceId}/settings`}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
            >
              Settings
            </Link>
          </div>
        </div>

        <AskBox workspaceId={workspaceId} />

        <h2 className="mb-3 text-sm font-medium text-slate-500">Projects</h2>
        {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && !error && (projects?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              No projects yet. Create your first project to start planning.
            </p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              New Project
            </button>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {projects?.map((p) => (
              <ProjectCard
                key={p.id}
                card={p}
                members={members ?? []}
                workspaceId={workspaceId}
                isAdmin={isAdmin}
              />
            ))}
          </div>
        )}
      </main>
      <NewProjectDialog
        open={creating}
        workspaceId={workspaceId}
        onClose={() => setCreating(false)}
        // The dialog stays open, showing "Creating…", until the project page
        // replaces this one: closing it first showed the empty project list
        // for the seconds the navigation takes (trust test, finding #4).
        onCreated={(project) => {
          refetch();
          router.push(`/w/${workspaceId}/p/${project.id}`);
        }}
      />
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
