import { useEffect, useState } from "react";
import { createDiscussion, listDiscussions, type Discussion } from "../api";

// Comment thread for one selected graph node (M12). Desktop's side of the
// "authoring allowed for discussions only" exception — everything else in
// GraphView stays read-only.
export default function DiscussionPanel({
  projectId,
  nodeType,
  nodeId,
  label,
}: {
  projectId: string;
  nodeType: string;
  nodeId: string;
  label: string;
}) {
  const [discussions, setDiscussions] = useState<Discussion[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const res = await listDiscussions(projectId, nodeType, nodeId);
    setDiscussions(res.discussions);
  }

  useEffect(() => {
    setDiscussions(null);
    reload().catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, nodeType, nodeId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setPosting(true);
    setError(null);
    try {
      await createDiscussion(projectId, nodeType, nodeId, draft.trim());
      setDraft("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="discussion-panel">
      <h4>Comments — {label}</h4>
      {error && <p className="error">{error}</p>}
      {discussions === null ? (
        <p>Loading…</p>
      ) : discussions.length === 0 ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul className="discussion-list">
          {discussions.map((d) => (
            <li key={d.id}>
              <span className="discussion-author">
                {d.author}
                {d.source === "pmo" && <span className="badge pmo"> Jira</span>}
              </span>
              <p>{d.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment…"
          rows={2}
        />
        <button type="submit" disabled={posting || !draft.trim()}>
          {posting ? "Posting…" : "Comment"}
        </button>
      </form>
    </div>
  );
}
