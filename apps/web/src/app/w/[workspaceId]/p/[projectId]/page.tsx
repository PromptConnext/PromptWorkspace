"use client";

import Link from "next/link";
import { use, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { PresenceBar } from "@/components/PresenceBar";
import { GraphBrowser } from "@/components/project/GraphBrowser";
import { Planner } from "@/components/project/Planner";
import { TaskBoard } from "@/components/project/TaskBoard";
import { ProgressRollup } from "@/components/project/ProgressRollup";
import { DiscussionThread } from "@/components/project/DiscussionThread";
import { useCloudGet } from "@/lib/hooks";
import type { ProjectGraph } from "@/lib/types";

const TABS = ["Planner", "Graph", "Tasks", "Progress", "Discussion"] as const;
type Tab = (typeof TABS)[number];

function ProjectWorkspace({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const [tab, setTab] = useState<Tab>("Planner");
  const {
    data: graph,
    error,
    loading,
    refetch,
  } = useCloudGet<ProjectGraph>(`/sync/projects/${projectId}/graph`);

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceId, href: `/w/${workspaceId}` },
          { label: graph?.project.name ?? projectId },
        ]}
      />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex gap-1 rounded border border-slate-200 bg-white p-1">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1.5 text-sm ${
                  tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <PresenceBar projectId={projectId} />
            <Link
              href={`/w/${workspaceId}/p/${projectId}/settings`}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300"
            >
              Settings
            </Link>
          </div>
        </div>

        {loading && <p className="text-sm text-slate-500">Loading graph…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {graph && (
          <>
            {tab === "Planner" && (
              <Planner project={graph.project} projectId={projectId} onChange={refetch} />
            )}
            {tab === "Graph" && <GraphBrowser graph={graph} />}
            {tab === "Tasks" && (
              <TaskBoard graph={graph} workspaceId={workspaceId} projectId={projectId} onChange={refetch} />
            )}
            {tab === "Progress" && <ProgressRollup graph={graph} />}
            {tab === "Discussion" && (
              <DiscussionThread graph={graph} projectId={projectId} onPosted={refetch} />
            )}
          </>
        )}
      </main>
    </>
  );
}

export default function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = use(params);
  return (
    <RequireAuth>
      <ProjectWorkspace workspaceId={workspaceId} projectId={projectId} />
    </RequireAuth>
  );
}
