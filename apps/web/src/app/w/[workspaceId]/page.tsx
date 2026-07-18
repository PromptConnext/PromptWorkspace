"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { Avatar } from "@/components/Avatar";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspace } from "@/lib/workspace";
import type { Project, Workspace, WorkspaceMember } from "@/lib/types";

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

function ProjectIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      className="h-5 w-5 shrink-0 text-slate-400"
    >
      <path
        d="M4 6.5A1.5 1.5 0 0 1 5.5 5h4l2 2h7A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkspaceHome({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { memberships, loading: wsLoading, error: wsError, setActiveWorkspace } = useWorkspace();
  const { data: workspace } = useCloudGet<Workspace>(`/workspaces/${workspaceId}`);
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const { data: projects, error, loading } = useCloudGet<Project[]>(
    `/workspaces/${workspaceId}/projects`,
  );

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
      <TopBar crumbs={[{ label: workspace?.name ?? workspaceId }]} />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {workspace?.name ?? "Workspace"}
          </h1>
          <Link
            href={`/w/${workspaceId}/members`}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300"
          >
            {members && members.length > 0 && <MemberStack members={members} />}
            <span className="text-sm text-slate-500">
              {members?.length ?? 0} {members?.length === 1 ? "member" : "members"}
            </span>
          </Link>
        </div>

        <h2 className="mb-3 text-sm font-medium text-slate-500">Projects</h2>
        {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && (projects?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              No projects yet. Link one from the desktop app to start tracking specs and tasks
              here.
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
            {projects?.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/w/${workspaceId}/p/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50"
                >
                  <ProjectIcon />
                  <span className="font-medium text-slate-900">{p.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
