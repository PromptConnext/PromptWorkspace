"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useNodeLabels } from "@/lib/node-labels";
import type { Discussion, ProjectGraph } from "@/lib/types";
import { AssistantPanel } from "./AssistantPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

const SOURCE_STYLE: Record<Discussion["source"], string> = {
  pz: "bg-indigo-100 text-indigo-700",
  pmo: "bg-amber-100 text-amber-700",
};

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
  // A comment cannot parent a comment: the cloud rejects it with 422
  // invalid_parent_node_type (_VALID_PARENT_TYPES, app/api/discussions.py:30).
  // useNodeLabels covers discussions because the assistant's citation chips
  // need those labels — this picker must not offer them as targets.
  const options = [...labels.entries()].filter(([key]) => !key.startsWith("discussions:"));
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
      <Select value={target} onValueChange={setTarget}>
        <SelectTrigger aria-label="Comment target" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  workspaceId,
  projectId,
  onPosted,
}: {
  graph: ProjectGraph;
  workspaceId: string;
  projectId: string;
  onPosted: () => void;
}) {
  const labels = useNodeLabels(graph);
  const [askOpen, setAskOpen] = useState(false);
  const sorted = [...graph.discussions].sort((a, b) =>
    (a.updated_at ?? "").localeCompare(b.updated_at ?? ""),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setAskOpen(true)}
          className="rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:border-slate-300"
        >
          Ask the assistant
        </button>
      </div>

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
                  {d.source === "pmo" ? "Jira" : "PromptWorkspace"}
                </span>
              </div>
              <p className="mt-1 font-medium">{d.author}</p>
              <p className="mt-1 text-slate-700">{d.body}</p>
            </li>
          ))}
        </ul>
      )}

      <AssistantPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        graph={graph}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </div>
  );
}
