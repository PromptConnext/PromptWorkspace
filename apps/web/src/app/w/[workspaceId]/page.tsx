"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { safeWebUrl } from "@/components/project/previewState";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspace, useWorkspaceName } from "@/lib/workspace";
import type { Project, WorkspaceMember } from "@/lib/types";

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
  const workspaceName = useWorkspaceName(workspaceId);
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
  const { data: projects, error, loading } = useCloudGet<Project[]>(
    `/workspaces/${workspaceId}/projects`,
  );

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
      <main className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {workspaceName}
          </h1>
          <div className="flex items-center gap-2">
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
                {members?.length ?? 0} {members?.length === 1 ? "member" : "members"}
              </span>
            </Link>
            <Link
              href={`/w/${workspaceId}/settings`}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
            >
              Settings
            </Link>
          </div>
        </div>

        <h2 className="mb-3 text-sm font-medium text-slate-500">Projects</h2>
        {loading && <p className="text-sm text-slate-500">Loading projects…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && (projects?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">
              No projects yet. Create one above, or link one from the desktop app.
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
            {projects?.map((p) => (
              // safeWebUrl because this href comes from a webhook payload
              // written by whoever can push to the project repo; React does
              // not sanitise href, so a javascript: URL here would execute in
              // this origin on click. The cloud refuses one on the storage
              // path too — this is the second half of that.
              //
              // The live link is a sibling of the row link, not nested
              // inside it: an anchor inside an anchor is invalid, and this is
              // the one place a business user can reach the running
              // application without first knowing which project it is (ADR
              // 0021).
              <li key={p.id} className="flex items-center hover:bg-slate-50">
                <Link
                  href={`/w/${workspaceId}/p/${p.id}`}
                  className="flex flex-1 items-center gap-3 px-4 py-3"
                >
                  <ProjectIcon />
                  <span className="flex-1 font-medium text-slate-900">{p.name}</span>
                </Link>
                {p.deployment_state?.state === "live" && safeWebUrl(p.deployment_state.url) && (
                  <a
                    href={safeWebUrl(p.deployment_state.url)!}
                    target="_blank"
                    rel="noreferrer"
                    title="Open the live application"
                    className="mr-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-900 hover:border-emerald-300"
                  >
                    <span
                      aria-hidden
                      className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
                    />
                    Live
                  </a>
                )}
                <span className="pr-4 text-sm text-slate-500">
                  {new Date(p.created_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
      <NewProjectDialog
        open={creating}
        workspaceId={workspaceId}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          setCreating(false);
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
