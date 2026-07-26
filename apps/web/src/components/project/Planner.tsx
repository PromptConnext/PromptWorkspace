// apps/web/src/components/project/Planner.tsx
"use client";

import { useEffect, useState } from "react";
import { apiFetch, getStageDocument, updateStageDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentUpload } from "./DocumentUpload";
import { useStageGeneration } from "./useStageGeneration";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import type { DocumentOut, Project, StageKind } from "@/lib/types";

const STAGE_ORDER: { stage: StageKind; label: string; buttonLabel: string }[] = [
  { stage: "specify", label: "Specify", buttonLabel: "Generate specification" },
  { stage: "plan", label: "Plan", buttonLabel: "Generate plan" },
  { stage: "tasks", label: "Tasks", buttonLabel: "Generate tasks" },
];

// One stepper section: an input for the business framing, a Generate
// button, and the live-streamed output. Each stage is independent state —
// there's no cross-stage gating in this sub-project (no approval concept
// yet, see the design doc's "No approval gate in this sub-project").
function StageSection({
  projectId,
  stage,
  label,
  buttonLabel,
}: {
  projectId: string;
  stage: StageKind;
  label: string;
  buttonLabel: string;
}) {
  const { authHeaders } = useAuth();
  const [input, setInput] = useState("");
  const { status, streamedText, result, error, generate } = useStageGeneration(projectId);

  const [docContent, setDocContent] = useState("");
  const [docLoaded, setDocLoaded] = useState(false);
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getStageDocument(projectId, stage, authHeaders())
      .then((doc) => {
        if (!cancelled) {
          setDocContent(doc.content);
          setDocLoaded(true);
        }
      })
      .catch(() => {
        // 404-as-empty is handled server-side (returns content: ""); any
        // other failure just leaves the editor empty rather than blocking render.
        if (!cancelled) setDocLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage]);

  useEffect(() => {
    if (status === "done" && result) {
      setDocContent(result.content);
    }
  }, [status, result]);

  async function saveDoc() {
    setDocSaving(true);
    setDocError(null);
    try {
      await updateStageDocument(projectId, stage, docContent, authHeaders());
    } catch (err) {
      setDocError((err as Error).message);
    } finally {
      setDocSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">{label}</h3>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
        className="mb-2 w-full rounded border border-slate-300 p-2 text-sm"
        placeholder="Describe the goal in plain business terms…"
      />
      <button
        type="button"
        disabled={status === "generating" || !input.trim()}
        onClick={() => generate(stage, input)}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-60"
      >
        {status === "generating" ? "Generating…" : buttonLabel}
      </button>

      {status === "generating" && streamedText && (
        <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
          {streamedText}
        </pre>
      )}
      {status === "error" && error && (
        <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
          <p>{error.error}</p>
          {error.retryable && (
            <button
              type="button"
              onClick={() => generate(stage, input)}
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {status === "done" && result && (
        <p className="mt-2 text-xs text-slate-500">
          {result.task_count !== undefined
            ? `${result.task_count} tasks created`
            : "Saved as a draft"}
        </p>
      )}

      {docLoaded && (
        <div className="mt-3">
          <MarkdownEditor
            value={docContent}
            onChange={setDocContent}
            onSave={saveDoc}
            saving={docSaving}
            error={docError}
          />
        </div>
      )}
    </div>
  );
}

export function Planner({
  project,
  projectId,
  onChange,
}: {
  project: Project;
  projectId: string;
  onChange: () => void;
}) {
  const { authHeaders } = useAuth();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (project.lifecycle_status !== "planning") {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
        This project has been sent to Tech Lead review — planning is read-only from here.
      </div>
    );
  }

  async function submitForReview() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiFetch(`/projects/${projectId}/lifecycle/submit-for-review`, authHeaders(), {
        method: "POST",
      });
      onChange();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <DocumentUpload projectId={projectId} onUploaded={(doc) => setDocuments((prev) => [...prev, doc])} />
      {documents.length > 0 && (
        <ul className="text-xs text-slate-500">
          {documents.map((d) => (
            <li key={d.id}>
              {d.title} — {d.status}
              {d.status === "failed" && " (couldn't extract text — try a text-based export)"}
            </li>
          ))}
        </ul>
      )}

      {STAGE_ORDER.map(({ stage, label, buttonLabel }) => (
        <StageSection key={stage} projectId={projectId} stage={stage} label={label} buttonLabel={buttonLabel} />
      ))}

      <div className="border-t border-slate-200 pt-4">
        <button
          type="button"
          disabled={submitting}
          onClick={submitForReview}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {submitting ? "Sending…" : "Send to Tech Lead"}
        </button>
        {submitError && <p className="mt-2 text-sm text-red-600">{submitError}</p>}
      </div>
    </div>
  );
}
