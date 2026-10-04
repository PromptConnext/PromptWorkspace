"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { TopBar } from "@/components/TopBar";
import { PresenceBar } from "@/components/PresenceBar";
import { GraphBrowser } from "@/components/project/GraphBrowser";
import { DecisionsPanel } from "@/components/project/DecisionsPanel";
import { DeliveryPlan } from "@/components/project/DeliveryPlan";
import { Planner } from "@/components/project/Planner";
import { PreviewPanel } from "@/components/project/PreviewPanel";
import { TaskBoard } from "@/components/project/TaskBoard";
import { BoardSkeleton } from "@/components/project/BoardColumn";
import { ProgressRollup } from "@/components/project/ProgressRollup";
import { DiscussionThread } from "@/components/project/DiscussionThread";
import { useCloudGet } from "@/lib/hooks";
import { useWorkspaceName } from "@/lib/workspace";
import type { ProjectGraph } from "@/lib/types";

// "Preview" is ungated on purpose (ADR 0021): a business user opening the
// running application is the reason it exists. It is always present, even
// with no deployment configured, so the strip does not change shape
// between projects.
const TABS = [
  "Planner",
  "Delivery",
  "Graph",
  "Tasks",
  "Progress",
  "Discussion",
  "Decisions",
  "Preview",
] as const;
type Tab = (typeof TABS)[number];

// The tab lives in `?tab=<slug>` so a refresh keeps it and the view is linkable.
const slugOf = (t: Tab) => t.toLowerCase();
function tabFromParam(value: string | null): Tab {
  return TABS.find((t) => slugOf(t) === value) ?? "Planner";
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function formatUpdated(lastUpdated: number, now: number): string {
  const minutes = Math.floor((now - lastUpdated) / 60000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${relativeTime.format(-minutes, "minute")}`;
  return `Updated ${relativeTime.format(-Math.floor(minutes / 60), "hour")}`;
}

// Freshness + manual refresh for the board. `now` ticks every 30s so the
// relative label stays honest without re-rendering the whole page each second.
function BoardFreshness({
  lastUpdated,
  refreshing,
  refreshError,
  onRefresh,
}: {
  lastUpdated: number | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  return (
    // No live region here: the relative label re-renders every 30s and would
    // be re-announced each time. Only a failed refresh is announced.
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>
        {refreshing
          ? "Refreshing…"
          : lastUpdated
            ? formatUpdated(lastUpdated, now)
            : ""}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className={`rounded border border-slate-200 bg-white px-2 py-1 text-slate-600 hover:border-slate-300 disabled:opacity-50 ${FOCUS_RING}`}
      >
        Refresh
      </button>
      {/* Mounted up front so the message is announced when it appears. */}
      <span role="status" className="text-amber-700">
        {refreshError && !refreshing
          ? "Couldn't refresh — showing last loaded data."
          : ""}
      </span>
      {refreshError && !refreshing && (
        <button
          type="button"
          onClick={onRefresh}
          className={`text-amber-700 underline ${FOCUS_RING}`}
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * The first graph load can take seconds; a skeleton shaped like the tab
 * about to appear reads as "on its way", where a line of text reads as stuck.
 */
function TabSkeleton({ tab }: { tab: Tab }) {
  if (tab === "Tasks") return <BoardSkeleton label="Loading project…" />;
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only" role="status">
        Loading project…
      </span>
      {["h-8 w-1/3", "h-24 w-full", "h-24 w-full", "h-24 w-2/3"].map((size, i) => (
        <div
          key={i}
          aria-hidden
          className={`${size} animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none`}
        />
      ))}
    </div>
  );
}

function ProjectWorkspace({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Preserves every other query param except the board's `task`.
  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", slugOf(next));
      // The open task belongs to the board; carried to another tab it would
      // reopen the drawer on the way back.
      if (next !== "Tasks") params.delete("task");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // WAI-ARIA tabs: arrows/Home/End move focus and activate (automatic activation).
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft")
      next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next]);
    tabRefs.current[TABS[next]]?.focus();
  };

  const workspaceName = useWorkspaceName(workspaceId);
  const {
    data: graph,
    error,
    loading,
    refetch,
    refreshing,
    refreshError,
    lastUpdated,
    revalidate,
  } = useCloudGet<ProjectGraph>(`/sync/projects/${projectId}/graph`, true, {
    refreshOnFocus: true,
    pollMs: 30000,
  });

  return (
    <>
      <TopBar
        crumbs={[
          { label: workspaceName, href: `/w/${workspaceId}` },
          { label: graph?.project.name ?? "Project", loading: loading && !graph },
        ]}
      />
      {/* The board needs the full width (4 columns); other tabs read better narrow. */}
      <main
        className={
          tab === "Tasks"
            ? "mx-auto max-w-none px-4 py-8 sm:px-6"
            : "mx-auto max-w-5xl px-4 py-8"
        }
      >
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div
            role="tablist"
            aria-label="Project sections"
            className="flex max-w-full gap-1 overflow-x-auto rounded border border-slate-200 bg-white p-1"
          >
            {TABS.map((t, i) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[t] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${slugOf(t)}`}
                aria-selected={tab === t}
                aria-controls="project-tabpanel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={`shrink-0 rounded px-3 py-1.5 text-sm ${FOCUS_RING} ${
                  tab === t
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "Tasks" && graph && (
            <BoardFreshness
              lastUpdated={lastUpdated}
              refreshing={refreshing}
              refreshError={refreshError}
              onRefresh={revalidate}
            />
          )}
          <div className="flex items-center gap-3">
            <PresenceBar projectId={projectId} />
            <Link
              href={`/w/${workspaceId}/p/${projectId}/settings`}
              className={`rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:border-slate-300 ${FOCUS_RING}`}
            >
              Settings
            </Link>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {tab !== "Tasks" && refreshError && graph && (
          <p className="mb-4 text-xs text-amber-700">
            Couldn&apos;t refresh — showing last loaded data.{" "}
            <button
              type="button"
              onClick={revalidate}
              className={`underline ${FOCUS_RING}`}
            >
              Retry
            </button>
          </p>
        )}
        <div
          role="tabpanel"
          id="project-tabpanel"
          aria-labelledby={`tab-${slugOf(tab)}`}
        >
          {/* Only the first load blocks; background refreshes keep the content up. */}
          {loading && !graph && <TabSkeleton tab={tab} />}
          {graph && (
            <>
              {tab === "Planner" && (
                <Planner
                  project={graph.project}
                  projectId={projectId}
                  onChange={refetch}
                  onOpenTasks={() => setTab("Tasks")}
                />
              )}
              {tab === "Delivery" && (
                <DeliveryPlan graph={graph} projectId={projectId} />
              )}
              {tab === "Graph" && <GraphBrowser graph={graph} />}
              {tab === "Tasks" && (
                <TaskBoard
                  graph={graph}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  onChange={refetch}
                  onOpenPlanner={() => setTab("Planner")}
                />
              )}
              {tab === "Progress" && (
                <ProgressRollup graph={graph} projectId={projectId} />
              )}
              {tab === "Discussion" && (
                <DiscussionThread
                  graph={graph}
                  workspaceId={workspaceId}
                  projectId={projectId}
                  onPosted={refetch}
                />
              )}
              {tab === "Preview" && (
                <PreviewPanel projectId={projectId} workspaceId={workspaceId} />
              )}
              {tab === "Decisions" && <DecisionsPanel projectId={projectId} workspaceId={workspaceId} />}
            </>
          )}
        </div>
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
      {/* useSearchParams needs a Suspense boundary for static prerender. */}
      <Suspense
        fallback={<p className="px-4 py-8 text-sm text-slate-500">Loading…</p>}
      >
        <ProjectWorkspace workspaceId={workspaceId} projectId={projectId} />
      </Suspense>
    </RequireAuth>
  );
}
