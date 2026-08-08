import { describe, expect, it } from "vitest";
import { citationLabel } from "./node-labels";
import type { Citation, NodeLabels } from "./node-labels";

const labels: NodeLabels = new Map([
  ["requirements:r1", "Requirement: Login must support SSO"],
  ["tasks:t1", "Task: Wire the OAuth callback"],
]);

function cite(over: Partial<Citation>): Citation {
  return {
    node_type: "requirements",
    node_id: "r1",
    chunk_index: 0,
    source: "vector",
    repo: null,
    path: null,
    start_line: null,
    end_line: null,
    ...over,
  };
}

describe("citationLabel", () => {
  it("uses the graph label for a graph-backed node type", () => {
    expect(citationLabel(cite({}), labels, new Map(), new Map())).toEqual({
      kind: "requirement",
      text: "Login must support SSO",
    });
  });

  it("labels a task from the graph", () => {
    const c = cite({ node_type: "tasks", node_id: "t1" });
    expect(citationLabel(c, labels, new Map(), new Map()).text).toBe("Wire the OAuth callback");
  });

  it("resolves an uploaded document from the document title map", () => {
    const c = cite({ node_type: "documents", node_id: "d1" });
    const docs = new Map([["d1", "PRD-v2.pdf"]]);
    expect(citationLabel(c, labels, docs, new Map())).toEqual({
      kind: "document",
      text: "PRD-v2.pdf",
    });
  });

  it("resolves a stage document to its stage name", () => {
    const c = cite({ node_type: "stage_documents", node_id: "s1" });
    const stages = new Map([["s1", "specify"]]);
    expect(citationLabel(c, labels, new Map(), stages)).toEqual({
      kind: "planning doc",
      text: "specify",
    });
  });

  it("renders a code citation as path and line range", () => {
    const c = cite({
      node_type: "code",
      node_id: "c1",
      source: "code",
      repo: "acme/api",
      path: "app/api/auth.py",
      start_line: 40,
      end_line: 72,
    });
    expect(citationLabel(c, labels, new Map(), new Map())).toEqual({
      kind: "code",
      text: "acme/api · app/api/auth.py:40-72",
    });
  });

  it("degrades an unresolvable node to its type and a short id", () => {
    const c = cite({ node_type: "pull_requests", node_id: "4a91c2ff-0000-0000-0000-000000000000" });
    expect(citationLabel(c, labels, new Map(), new Map())).toEqual({
      kind: "pull request",
      text: "4a91c2ff",
    });
  });

  it("degrades a graph type whose node is missing from the graph", () => {
    const c = cite({ node_id: "gone-1234-5678" });
    expect(citationLabel(c, labels, new Map(), new Map()).text).toBe("gone-123");
  });
});
