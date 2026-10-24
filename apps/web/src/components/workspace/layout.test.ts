import { describe, expect, it } from "vitest";
import type { PersonLink, ProjectCard, WorkspaceMember } from "@/lib/types";
import { layoutGraph } from "./layout";

const m = (id: string): WorkspaceMember => ({
  workspace_id: "w1", user_id: id, email: `${id}@x.co`, display_name: id.toUpperCase(),
  role: "member", invited_by: null, created_at: "2026-01-01T00:00:00Z",
});
const card = (id: string) => ({ id, name: id }) as unknown as ProjectCard;
const members = [m("u1"), m("u2"), m("u3")];
const cards = [card("p1"), card("p2")];
const links: PersonLink[] = [
  { kind: "hat", from_user_id: "u1", to_user_id: null, project_id: "p1", hat: "business_owner", weight: 1 },
  { kind: "work", from_user_id: "u2", to_user_id: null, project_id: "p2", hat: null, weight: 3 },
  { kind: "approval", from_user_id: "u1", to_user_id: "u3", project_id: null, hat: null, weight: 1 },
];

describe("layoutGraph", () => {
  it("is deterministic for the same input", () => {
    const a = layoutGraph(members, cards, links, 900, 560);
    const b = layoutGraph(members, cards, links, 900, 560);
    expect(b).toEqual(a);
  });

  it("places every member and project node inside the viewport", () => {
    const { nodes, edges } = layoutGraph(members, cards, links, 400, 300);
    expect(nodes).toHaveLength(5);
    expect(edges).toHaveLength(3);
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(400);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(300);
    }
  });
});
