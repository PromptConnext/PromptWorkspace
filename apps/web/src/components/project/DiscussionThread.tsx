"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Discussion, ProjectGraph } from "@/lib/types";

const SOURCE_STYLE: Record<Discussion["source"], string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-700",
};

// (nodeType, nodeId) -> human label, built once from the graph so both the
// compose picker and the thread list can show "Task: Build login form"
// instead of a raw id.
function useNodeLabels(graph: ProjectGraph) {
  return useMemo(() => {
    const labels = new Map<string, string>();
    for (const r of graph.requirements) labels.set(`requirements:${r.id}`, `Requirement: ${r.title}`);
    for (const s of graph.spec_documents) {
      labels.set(`spec_documents:${s.id}`, `Spec v${s.version}`);
    }
    for (const t of graph.tasks) labels.set(`tasks:${t.id}`, `Task: ${t.title}`);
    for (const a of graph.artifacts) labels.set(`artifacts:${a.id}`, `Artifact: ${a.uri}`);
    return labels;
  }, [graph]);
}

function ComposeBox({
  graph,
  labels,
  projectId,
  onPosted,
}: {
  graph: ProjectGraph;
  labels: Map<string, string>;
  projectId: string;
  onPosted: () => void;
}) {
  const { authHeaders } = useAuth();
  const options = [...labels.entries()];
  const [target, setTarget] = useState(options[0]?.[0] ?? "");
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !body.trim()) return;
    const [parent_node_type, parent_node_id] = target.split(":");
    setPosting(true);
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/discussions`, authHeaders(), {
        method: "POST",
        body: JSON.stringify({ parent_node_type, parent_node_id, body: body.trim() }),
      });
      setBody("");
      onPosted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  if (options.length === 0) {
    return <p className="text-sm text-slate-500">Nothing to comment on yet.</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded border border-slate-200 bg-white p-3">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      >
        {options.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment…"
        rows={2}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={posting || !body.trim()}
        className="self-start rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
      >
        {posting ? "Posting…" : "Comment"}
      </button>
    </form>
  );
}

export function DiscussionThread({
  graph,
  projectId,
  onPosted,
}: {
  graph: ProjectGraph;
  projectId: string;
  onPosted: () => void;
}) {
  const labels = useNodeLabels(graph);
  const sorted = [...graph.discussions].sort((a, b) =>
    (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
  );

  return (
    <div className="flex flex-col gap-4">
      <ComposeBox graph={graph} labels={labels} projectId={projectId} onPosted={onPosted} />

      {sorted.length === 0 ? (
        <p className="text-sm text-slate-500">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((d) => (
            <li key={d.id} className="rounded border border-slate-200 bg-white p-3 text-sm">
              <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                <span>{labels.get(`${d.parent_node_type}:${d.parent_node_id}`) ?? d.parent_node_type}</span>
                <span className={`rounded px-1.5 py-0.5 font-medium ${SOURCE_STYLE[d.source]}`}>
                  {d.source === "pmo" ? "Jira" : "PromptConnext"}
                </span>
              </div>
              <p className="mt-1 font-medium">{d.author}</p>
              <p className="mt-1 text-slate-700">{d.body}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
