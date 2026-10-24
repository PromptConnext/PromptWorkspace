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
    return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  return { nodes, edges };
}
