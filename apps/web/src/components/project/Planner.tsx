// apps/web/src/components/project/Planner.tsx
"use client";

import { useEffect, useState } from "react";
import { apiFetch, getStageDocument, startTechReview, updateStageDocument } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { DocumentUpload } from "./DocumentUpload";
import { useStageGeneration } from "./useStageGeneration";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { CreateRepositoryPanel } from "./CreateRepositoryPanel";
import type { DocumentOut, Project, StageKind } from "@/lib/types";

// Derived view: repo_seed.py's table of paths written at repo creation.
// The create-repository endpoint returns only the Project, not a file list,
// so this mirrors the cloud's fixed seed set for display purposes.
const SEEDED_FILES = [
  "AGENTS.md",
  "README.md",
  "docs/scope.md",
  "docs/architecture.md",
  "docs/tasks.md",
  "docs/conventions.md",
];

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
  readOnly = false,
}: {
  projectId: string;
  stage: StageKind;
  label: string;
  buttonLabel: string;
  readOnly?: boolean;
}) {
  const { authHeaders } = useAuth();
  const [input, setInput] = useState("");
  const { status, streamedText, result, error, generate } = useStageGeneration(projectId);

  const [docContent, setDocContent] = useState("");
  const [docLoaded, setDocLoaded] = useState(false);
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docUpdatedAt, setDocUpdatedAt] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Every previously generated or hand-edited stage document is fetched on
  // mount, so reopening the project shows the work as it was left rather than
  // an empty editor. The generation endpoint auto-saves here before it touches
  // the graph, so this covers partial and rejected generations too.
  useEffect(() => {
    let cancelled = false;
    getStageDocument(projectId, stage, authHeaders())
      .then((doc) => {
        if (cancelled) return;
        setDocContent(doc.content);
        setDocUpdatedAt(doc.updated_at);
        setDocLoaded(true);
      })
      .catch(() => {
        // A missing document is not an error server-side (it returns
        // content: ""), so reaching this branch means the fetch itself
        // failed. Render the editor anyway, but say the existing content
        // couldn't be loaded — an empty box would read as "nothing saved".
        if (cancelled) return;
        setLoadFailed(true);
        setDocLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage]);

  useEffect(() => {
    if (status === "done" && result) {
      setDocContent(result.content);
      setDocUpdatedAt(result.updated_at ?? null);
    }
  }, [status, result]);

  // A failed generation that still saved a draft (unparseable or truncated
  // output) leaves text on the server the stream never handed us — pull it in
  // so the editor shows what was kept instead of the pre-generation content.
  useEffect(() => {
    if (status !== "error" || !error?.draft_saved) return;
    let cancelled = false;
    getStageDocument(projectId, stage, authHeaders())
      .then((doc) => {
        if (cancelled) return;
        setDocContent(doc.content);
        setDocUpdatedAt(doc.updated_at);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, error, projectId, stage]);

  async function saveDoc() {
    setDocSaving(true);
    setDocError(null);
    try {
      const doc = await updateStageDocument(projectId, stage, docContent, authHeaders());
      setDocUpdatedAt(doc.updated_at);
    } catch (err) {
      setDocError((err as Error).message);
    } finally {
      setDocSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="mb-2 text-sm font-medium text-slate-900">{label}</h3>
      {!readOnly && (
        <>
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
          {status === "done" && result?.truncated && (
            <div className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">This document is incomplete</p>
              <p className="mt-1">
                The model reached its output limit before finishing. The partial document below
                was saved — generate again, or fill in the rest by hand.
              </p>
              <button
                type="button"
                onClick={() => generate(stage, input)}
                className="mt-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs"
              >
                Generate again
              </button>
            </div>
          )}
          {status === "done" && result && (
            <p className="mt-2 text-xs text-slate-500">
              {result.task_count !== undefined
                ? `${result.task_count} tasks created`
                : "Saved as a draft"}
              {result.saved === false && " — couldn't be saved; copy this text before leaving"}
            </p>
          )}
        </>
      )}

      {docLoaded && (
        <div className="mt-3">
          {loadFailed && (
            <p className="mb-2 text-xs text-amber-700">
              Couldn&apos;t load the saved document — reload before editing, or you may overwrite
              it.
            </p>
          )}
          <MarkdownEditor
            value={docContent}
            onChange={setDocContent}
            onSave={saveDoc}
            saving={docSaving}
            error={docError}
            readOnly={readOnly}
          />
          {docUpdatedAt && (
            <p className="mt-1 text-xs text-slate-500">
              Last saved {new Date(docUpdatedAt).toLocaleString()}
            </p>
          )}
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
  const [startingReview, setStartingReview] = useState(false);
  const [startReviewError, setStartReviewError] = useState<string | null>(null);

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

  async function handleStartTechReview() {
    setStartingReview(true);
    setStartReviewError(null);
    try {
      await startTechReview(projectId, authHeaders());
      onChange();
    } catch (err) {
      setStartReviewError((err as Error).message);
    } finally {
      setStartingReview(false);
    }
  }

  if (project.lifecycle_status === "pending_tech_review") {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          This project has been sent to Tech Lead review — planning is read-only from here.
        </div>

        {STAGE_ORDER.map(({ stage, label, buttonLabel }) => (
          <StageSection
            key={stage}
            projectId={projectId}
            stage={stage}
            label={label}
            buttonLabel={buttonLabel}
            readOnly
          />
        ))}

        <div className="border-t border-slate-200 pt-4">
          <button
            type="button"
            disabled={startingReview}
            onClick={handleStartTechReview}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {startingReview ? "Starting…" : "Start tech review"}
          </button>
          {startReviewError && <p className="mt-2 text-sm text-red-600">{startReviewError}</p>}
        </div>
      </div>
    );
  }

  if (project.lifecycle_status === "tech_review") {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          In tech review — stage documents are editable again. Create the repository below once
          the constitution is ready.
        </div>

        {STAGE_ORDER.map(({ stage, label, buttonLabel }) => (
          <StageSection key={stage} projectId={projectId} stage={stage} label={label} buttonLabel={buttonLabel} />
        ))}

        <CreateRepositoryPanel projectId={projectId} projectName={project.name} onCreated={onChange} />
      </div>
    );
  }

  if (project.lifecycle_status === "repo_created") {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-medium">Repository created</p>
          {project.repo_url && (
            <p className="mt-1">
              <a
                href={project.repo_url}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-emerald-700"
              >
                {project.repo_url}
              </a>
            </p>
          )}
          {project.repo_default_branch && (
            <p className="mt-1 text-emerald-800">Default branch: {project.repo_default_branch}</p>
          )}
          <p className="mt-2 text-emerald-800">Seeded files:</p>
          <ul className="ml-4 list-disc text-emerald-800">
            {SEEDED_FILES.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <p className="mt-2">Developers can now clone this repo in the PromptZone desktop app.</p>
        </div>

        {STAGE_ORDER.map(({ stage, label, buttonLabel }) => (
          <StageSection
            key={stage}
            projectId={projectId}
            stage={stage}
            label={label}
            buttonLabel={buttonLabel}
            readOnly
          />
        ))}
      </div>
    );
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
