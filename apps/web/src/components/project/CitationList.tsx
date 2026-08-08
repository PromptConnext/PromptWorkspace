"use client";

// Sources behind an answer. Chips are labels, not links: the graph types would
// need selection props threaded into GraphBrowser and TaskBoard, and code
// chips are deferred rather than impossible — Citation carries repo/path/lines
// precisely so a client can link to the Git host later.

import { citationLabel, type NodeLabels } from "@/lib/node-labels";
import type { Citation } from "@/lib/types";

export function CitationList({
  citations,
  labels,
  documentTitles,
  stageNames,
}: {
  citations: Citation[];
  labels: NodeLabels;
  documentTitles: Map<string, string>;
  stageNames: Map<string, string>;
}) {
  if (citations.length === 0) return null;

  // vector_search runs at top_k=8, so one node commonly comes back at several
  // chunk indexes. To a reader that is one source, not three.
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    const key = `${c.node_type}:${c.node_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const ordered = [
    ...unique.filter((c) => c.source !== "code"),
    ...unique.filter((c) => c.source === "code"),
  ];

  return (
    <div className="mt-2">
      <p className="text-xs uppercase tracking-wide text-slate-500">Sources</p>
      <ul className="mt-1 flex flex-col gap-1">
        {ordered.map((c) => {
          const { kind, text } = citationLabel(c, labels, documentTitles, stageNames);
          return (
            <li key={`${c.node_type}:${c.node_id}`} className="text-xs text-slate-600">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                {kind}
              </span>{" "}
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
