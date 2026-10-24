"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { memberFullName } from "@/components/project/MemberChip";
import { avatarColor, initial } from "@/lib/identity";
import type { WorkspaceOverview } from "@/lib/types";
import { layoutGraph } from "./layout";
import type { PositionedEdge } from "./layout";

const DEFAULT_W = 900;
const DEFAULT_H = 560;
const HAT_STROKE: Record<string, string> = {
  business_owner: "#059669", // emerald-600
  tech_steward: "#0284c7", // sky-600
};
const SLATE_300 = "#cbd5e1";
const SLATE_500 = "#64748b";
const FOLDER = "M-9 -6h6l2 2h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z";

// The avatar's Tailwind pair, as the hex fill/ink an SVG circle needs.
const AVATAR_HEX: Record<string, [string, string]> = {
  rose: ["#ffe4e6", "#be123c"],
  amber: ["#fef3c7", "#b45309"],
  lime: ["#ecfccb", "#4d7c0f"],
  teal: ["#ccfbf1", "#0f766e"],
  sky: ["#e0f2fe", "#0369a1"],
  violet: ["#ede9fe", "#6d28d9"],
  fuchsia: ["#fae8ff", "#a21caf"],
};
function avatarHex(identity: Parameters<typeof avatarColor>[0]): [string, string] {
  const name = /bg-(\w+)-100/.exec(avatarColor(identity))?.[1] ?? "sky";
  return AVATAR_HEX[name] ?? AVATAR_HEX.sky;
}

function edgeStyle(e: PositionedEdge) {
  if (e.kind === "hat") return { stroke: HAT_STROKE[e.hat ?? ""] ?? SLATE_500, width: 2.5, dash: undefined };
  if (e.kind === "work") return { stroke: SLATE_300, width: 1 + Math.min(3, Math.max(0, e.weight - 1)), dash: undefined };
  return { stroke: SLATE_500, width: 1.5, dash: "5 4" };
}

export function WorkspaceMap({
  overview,
  workspaceId,
  onSelectMember,
  width,
  height,
}: {
  overview: WorkspaceOverview;
  workspaceId: string;
  onSelectMember: (id: string) => void;
  width?: number;
  height?: number;
}) {
  const router = useRouter();
  const arrowId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const w = width ?? measured ?? DEFAULT_W;
  const h = height ?? DEFAULT_H;

  const { members, projects, people } = overview;
  const connected = new Set(people.flatMap((l) => [l.from_user_id, l.to_user_id ?? ""]));
  const nothing = projects.length === 0 && !members.some((m) => connected.has(m.user_id));
  useEffect(() => {
    const el = box.current;
    if (width !== undefined || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setMeasured(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, nothing]);

  const { nodes, edges } = useMemo(
    () => layoutGraph(members, projects, people, w, h),
    [members, projects, people, w, h],
  );
  const memberById = useMemo(() => new Map(members.map((m) => [m.user_id, m])), [members]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  if (nothing) {
    return <p className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Nothing to map yet</p>;
  }

  const activate = (type: "member" | "project", refId: string) => {
    if (type === "project") router.push(`/w/${workspaceId}/p/${refId}`);
    else onSelectMember(refId);
  };

  return (
    <div ref={box} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <svg
        role="img"
        aria-label="Workspace map"
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        className="block"
      >
        <title>Workspace map</title>
        <defs>
          <marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill={SLATE_500} />
          </marker>
        </defs>
        <g>
          {edges.map((e) => {
            const s = edgeStyle(e);
            const lit = hover === null || hover === e.from || hover === e.to;
            return (
              <path
                key={e.key}
                data-edge={e.kind}
                d={`M${e.x1} ${e.y1}L${e.x2} ${e.y2}`}
                fill="none"
                stroke={s.stroke}
                strokeWidth={s.width}
                strokeDasharray={s.dash}
                markerEnd={e.kind === "approval" ? `url(#${arrowId})` : undefined}
                opacity={lit ? 1 : 0.25}
              />
            );
          })}
        </g>
        {nodes.map((n) => {
          const isMember = n.type === "member";
          const m = isMember ? memberById.get(n.refId) : undefined;
          const p = isMember ? undefined : projectById.get(n.refId);
          const label = isMember ? memberFullName(m) : (p?.name ?? n.refId);
          const dim = hover !== null && hover !== n.id && !edges.some(
            (e) => (e.from === hover && e.to === n.id) || (e.to === hover && e.from === n.id),
          );
          const [fill, ink] = m ? avatarHex(m) : ["#f8fafc", "#334155"];
          return (
            <g
              key={n.id}
              data-node={n.id}
              transform={`translate(${n.x} ${n.y})`}
              tabIndex={0}
              role="button"
              aria-label={`${label}, ${n.type}`}
              opacity={dim ? 0.25 : 1}
              className="cursor-pointer outline-none focus-visible:[&>.shape]:stroke-slate-900"
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              onClick={() => activate(n.type, n.refId)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  activate(n.type, n.refId);
                }
              }}
            >
              {isMember ? (
                <>
                  <circle className="shape" r={18} fill={fill} stroke="#fff" strokeWidth={2} />
                  <text textAnchor="middle" dy="0.35em" fontSize={14} fontWeight={600} fill={ink}>
                    {m ? initial(m) : "?"}
                  </text>
                  <text y={32} textAnchor="middle" fontSize={11} fill="#475569">{label}</text>
                </>
              ) : (
                <>
                  <rect className="shape" x={-56} y={-16} width={112} height={32} rx={8} fill={fill} stroke="#cbd5e1" strokeWidth={1.5} />
                  <path d={FOLDER} transform="translate(-38 0)" fill="none" stroke={ink} strokeWidth={1.5} />
                  <text x={-22} dy="0.35em" fontSize={12} fill={ink}>
                    {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
