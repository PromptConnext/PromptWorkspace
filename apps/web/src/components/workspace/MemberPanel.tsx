"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useCloudGet } from "@/lib/hooks";
import { memberFullName } from "@/components/project/MemberChip";
import type {
  DecisionKind,
  DecisionsOut,
  InboxItem,
  ProjectHat,
  WorkspaceMember,
  WorkspaceOverview,
} from "@/lib/types";

const HAT_LABEL: Record<string, string> = {
  business_owner: "Business owner",
  tech_steward: "Tech steward",
};
const KIND_LABEL: Record<DecisionKind, string> = {
  intent_approval: "Intent approval",
  plan_approval: "Plan approval",
};

interface Waiting {
  key: string;
  kind: DecisionKind;
  projectId: string;
  projectName: string;
}

/** Fetches one project's open decisions and reports those routed to the hats
 *  the member holds there. Renders nothing. */
function ProjectDecisionsProbe({
  projectId,
  projectName,
  hats,
  onItems,
}: {
  projectId: string;
  projectName: string;
  hats: ProjectHat[];
  onItems: (projectId: string, items: Waiting[]) => void;
}) {
  const { data } = useCloudGet<DecisionsOut>(`/projects/${projectId}/decisions`);
  useEffect(() => {
    if (!data) return;
    onItems(
      projectId,
      data.decisions
        .filter((d) => d.status === "open" && hats.includes(d.routed_hat))
        .map((d) => ({ key: d.id, kind: d.kind, projectId, projectName })),
    );
  }, [data, hats, projectId, projectName, onItems]);
  return null;
}

function SelfDecisions({
  workspaceId,
  onItems,
}: {
  workspaceId: string;
  onItems: (projectId: string, items: Waiting[]) => void;
}) {
  const { data } = useCloudGet<InboxItem[]>(
    `/me/decisions?workspace_id=${encodeURIComponent(workspaceId)}`,
  );
  useEffect(() => {
    if (!data) return;
    const byProject = new Map<string, Waiting[]>();
    for (const i of data) {
      const list = byProject.get(i.project_id) ?? [];
      list.push({
        key: i.decision.id,
        kind: i.decision.kind,
        projectId: i.project_id,
        projectName: i.project_name,
      });
      byProject.set(i.project_id, list);
    }
    for (const [pid, items] of byProject) onItems(pid, items);
  }, [data, onItems]);
  return null;
}

const plural = (n: number) => `${n} task${n === 1 ? "" : "s"} assigned`;

export function MemberPanel({
  member,
  overview,
  viewerIsAdmin,
  viewerId,
  workspaceId,
}: {
  member: WorkspaceMember;
  overview: WorkspaceOverview;
  viewerIsAdmin: boolean;
  viewerId: string;
  workspaceId: string;
}) {
  const uid = member.user_id;
  const isSelf = viewerId === uid;
  const canSeeQueue = isSelf || viewerIsAdmin;

  const names = useMemo(
    () => new Map(overview.projects.map((p) => [p.id, p.name])),
    [overview.projects],
  );
  const hatEdges = overview.people.filter(
    (l) => l.kind === "hat" && l.from_user_id === uid && l.project_id && l.hat,
  );
  const workEdges = overview.people.filter(
    (l) => l.kind === "work" && l.from_user_id === uid && l.project_id,
  );
  const projectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const l of [...hatEdges, ...workEdges]) ids.add(l.project_id as string);
    for (const p of overview.projects) if (p.contributors.includes(uid)) ids.add(p.id);
    return overview.projects.filter((p) => ids.has(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, uid]);
  const assigned = workEdges.reduce((n, l) => n + l.weight, 0);

  const hatsByProject = useMemo(() => {
    const m = new Map<string, ProjectHat[]>();
    for (const l of hatEdges) {
      const list = m.get(l.project_id as string) ?? [];
      list.push(l.hat as ProjectHat);
      m.set(l.project_id as string, list);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, uid]);

  const [waiting, setWaiting] = useState<Record<string, Waiting[]>>({});
  const onItems = useMemo(
    () => (pid: string, items: Waiting[]) =>
      setWaiting((prev) => (prev[pid]?.map((w) => w.key).join() === items.map((w) => w.key).join() && pid in prev ? prev : { ...prev, [pid]: items })),
    [],
  );
  const queue = Object.values(waiting).flat();

  return (
    <aside aria-label={`${memberFullName(member)} details`} className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-slate-900">{memberFullName(member)}</h2>

      {isSelf && canSeeQueue && <SelfDecisions workspaceId={workspaceId} onItems={onItems} />}
      {!isSelf && viewerIsAdmin &&
        [...hatsByProject].map(([pid, hats]) => (
          <ProjectDecisionsProbe
            key={pid}
            projectId={pid}
            projectName={names.get(pid) ?? pid}
            hats={hats}
            onItems={onItems}
          />
        ))}

      <section className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Hats</h3>
        {hatEdges.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No hats</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm text-slate-900">
            {hatEdges.map((l) => (
              <li key={`${l.project_id}:${l.hat}`}>
                {HAT_LABEL[l.hat as string] ?? l.hat} · {names.get(l.project_id as string) ?? l.project_id}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Projects</h3>
        {projectIds.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No projects yet</p>
        ) : (
          <ul className="mt-1 space-y-1 text-sm">
            {projectIds.map((p) => (
              <li key={p.id}>
                <Link href={`/w/${workspaceId}/p/${p.id}`} className="text-slate-900 hover:underline">
                  {p.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-4">
        <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Assigned</h3>
        <p className="mt-1 text-sm text-slate-900">{plural(assigned)}</p>
      </section>

      {canSeeQueue && (
        <section className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">Decisions waiting</h3>
          {queue.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">Nothing waiting</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {queue.map((w) => (
                <li key={w.key}>
                  <Link
                    href={`/w/${workspaceId}/p/${w.projectId}?tab=decisions`}
                    className="text-slate-900 hover:underline"
                  >
                    {KIND_LABEL[w.kind]} · {w.projectName}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </aside>
  );
}
