"use client";

// (nodeType, nodeId) -> human label. Lifted out of DiscussionThread so the
// assistant panel's citation chips can reuse it instead of building a second
// map, and extended to the node types RAG_NODE_TYPES can cite
// (apps/cloud/app/rag/source.py:43) but ProjectGraph does not carry.

import { useMemo } from "react";
import type { Citation, ProjectGraph } from "./types";

export type { Citation };
export type NodeLabels = Map<string, string>;

export function useNodeLabels(graph: ProjectGraph): NodeLabels {
  return useMemo(() => {
    const labels: NodeLabels = new Map();
    for (const r of graph.requirements)
      labels.set(`requirements:${r.id}`, `Requirement: ${r.title}`);
    for (const s of graph.spec_documents) labels.set(`spec_documents:${s.id}`, `Spec v${s.version}`);
    for (const t of graph.tasks) labels.set(`tasks:${t.id}`, `Task: ${t.title}`);
    for (const a of graph.artifacts) labels.set(`artifacts:${a.id}`, `Artifact: ${a.uri}`);
    for (const d of graph.discussions) labels.set(`discussions:${d.id}`, `Comment by ${d.author}`);
    return labels;
  }, [graph]);
}

// Reader-facing name for each node_type a citation can carry.
const KIND: Record<string, string> = {
  requirements: "requirement",
  spec_documents: "spec",
  tasks: "task",
  discussions: "comment",
  documents: "document",
  stage_documents: "planning doc",
  pull_requests: "pull request",
  code: "code",
};

// The graph labels carry a "Requirement: " / "Task: " style prefix for the
// discussion picker's flat <select>. Chips already show the kind separately,
// so strip it rather than rendering "requirement · Requirement: …".
function stripPrefix(label: string): string {
  const idx = label.indexOf(": ");
  return idx === -1 ? label : label.slice(idx + 2);
}

export function citationLabel(
  citation: Citation,
  labels: NodeLabels,
  documentTitles: Map<string, string>,
  stageNames: Map<string, string>,
): { kind: string; text: string } {
  const kind = KIND[citation.node_type] ?? citation.node_type;

  if (citation.source === "code") {
    const range =
      citation.start_line != null && citation.end_line != null
        ? `:${citation.start_line}-${citation.end_line}`
        : "";
    const path = citation.path ?? citation.node_id;
    return { kind: "code", text: citation.repo ? `${citation.repo} · ${path}${range}` : `${path}${range}` };
  }

  if (citation.node_type === "documents") {
    const title = documentTitles.get(citation.node_id);
    if (title) return { kind, text: title };
  }

  if (citation.node_type === "stage_documents") {
    const stage = stageNames.get(citation.node_id);
    if (stage) return { kind, text: stage };
  }

  const label = labels.get(`${citation.node_type}:${citation.node_id}`);
  if (label) return { kind, text: stripPrefix(label) };

  // Nothing resolved it — a shortened id still lets someone match it against
  // an API response, which a truncated UUID prefix does well enough.
  return { kind, text: citation.node_id.slice(0, 8) };
}
