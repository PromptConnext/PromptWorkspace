import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { PersonLink, ProjectCard, WorkspaceMember } from "@/lib/types";

export interface PositionedNode {
  /** `m:<user_id>` or `p:<project_id>`; unique across both kinds. */
  id: string;
  type: "member" | "project";
  /** The user id or project id, without the prefix. */
  refId: string;
  x: number;
  y: number;
}

export interface PositionedEdge {
  key: string;
  kind: PersonLink["kind"];
  hat: string | null;
  weight: number;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Positioned = PositionedNode | PositionedEdge;

/** Half-extents kept clear of the viewport edge (a project box is the wider). */
const MARGIN_X = 70;
const MARGIN_Y = 28;
const TICKS = 300;
/** Drawn size of a node: member circle radius, project box half-extents. */
const MEMBER_R = 18;
const BOX_HX = 56;
const BOX_HY = 16;
/** Length of the approval arrowhead, so the tip lands on the node edge. */
const ARROW_LEN = 10;

/** Distance from a node's centre to its outline along the unit direction (ux, uy). */
function reach(type: "member" | "project", ux: number, uy: number): number {
  if (type === "member") return MEMBER_R;
  return Math.min(ux === 0 ? Infinity : BOX_HX / Math.abs(ux), uy === 0 ? Infinity : BOX_HY / Math.abs(uy));
}

type SimNode = SimulationNodeDatum & { id: string; type: "member" | "project"; refId: string };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Lays the people map out with d3-force, run to completion: the same input
 * always gives the same picture (no animation, no randomness).
 */
export function layoutGraph(
  members: WorkspaceMember[],
  cards: ProjectCard[],
  links: PersonLink[],
  width: number,
  height: number,
): { nodes: PositionedNode[]; edges: PositionedEdge[] } {
  const total = members.length + cards.length;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 3;

  // Fixed start: evenly round a circle, in reading order (members, then projects).
  const raw: Omit<SimNode, "x" | "y">[] = [
    ...members.map((m) => ({ id: `m:${m.user_id}`, type: "member" as const, refId: m.user_id })),
    ...cards.map((c) => ({ id: `p:${c.id}`, type: "project" as const, refId: c.id })),
  ];
  const simNodes: SimNode[] = raw.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(total, 1);
    return { ...n, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  const known = new Set(simNodes.map((n) => n.id));

  const edgeDefs = links.flatMap((l, i) => {
    const from = `m:${l.from_user_id}`;
    const to = l.kind === "approval"
      ? l.to_user_id ? `m:${l.to_user_id}` : null
      : l.project_id ? `p:${l.project_id}` : null;
    if (!to || !known.has(from) || !known.has(to)) return [];
    return [{ key: `${l.kind}:${i}`, kind: l.kind, hat: l.hat, weight: l.weight, from, to }];
  });

  const simLinks: SimulationLinkDatum<SimNode>[] = edgeDefs.map((e) => ({ source: e.from, target: e.to }));
  const sim = forceSimulation<SimNode>(simNodes)
    .force("link", forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks).id((d) => d.id).distance(110))
    .force("charge", forceManyBody().strength(-260))
    .force("center", forceCenter(cx, cy))
    .force("collide", forceCollide(44))
    .stop();
  for (let i = 0; i < TICKS; i++) sim.tick();

  const loX = Math.min(MARGIN_X, width / 2);
  const loY = Math.min(MARGIN_Y, height / 2);
  const nodes: PositionedNode[] = simNodes.map((n) => ({
    id: n.id,
    type: n.type,
    refId: n.refId,
    x: clamp(n.x ?? cx, loX, width - loX),
    y: clamp(n.y ?? cy, loY, height - loY),
  }));
  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges: PositionedEdge[] = edgeDefs.map((e) => {
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    // Trim both ends to the node outlines (the arrow tip, too, stays visible).
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    const ux = dx / len;
    const uy = dy / len;
    const startCut = reach(a.type, ux, uy);
    const endCut = reach(b.type, -ux, -uy) + (e.kind === "approval" ? ARROW_LEN : 0);
    if (startCut + endCut >= len) return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    return {
      ...e,
      x1: a.x + ux * startCut,
      y1: a.y + uy * startCut,
      x2: b.x - ux * endCut,
      y2: b.y - uy * endCut,
    };
  });
  return { nodes, edges };
}
