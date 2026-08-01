// apps/web/src/components/project/Planner.tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiFetch,
  getStageDocument,
  listDocuments,
  startTechReview,
  updateStageDocument,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { DocumentUpload } from "./DocumentUpload";
import { DocumentPreview } from "./DocumentPreview";
import { useStageGeneration } from "./useStageGeneration";
import { StageInputForm } from "./StageInputForm";
import {
  composeStageInput,
  PREFILLABLE_STAGES,
  requiredFieldsFilled,
  STAGE_FIELDS,
  TASKS_INPUT,
  type StageAnswers,
} from "./stage-forms";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { CreateRepositoryPanel } from "./CreateRepositoryPanel";
import type { DocumentOut, Project, StageKind, WorkspaceMember } from "@/lib/types";

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

type StageMeta = {
  stage: StageKind;
  label: string;
  buttonLabel: string;
  blurb: string;
  /** The stage whose document must exist first; the cloud enforces the same
   *  order by 409-ing on a missing Requirement / SpecDocument. */
  requires?: StageKind;
};

const STAGE_ORDER: StageMeta[] = [
  {
    stage: "constitution",
    label: "Project rules",
    buttonLabel: "Generate rules",
    blurb:
      "The project's standing rules. They steer every later stage and become AGENTS.md in the " +
      "repository — what the coding agent reads before it writes anything. The repository can't " +
      "be created without them.",
  },
  {
    stage: "specify",
    label: "1 · Specify",
    buttonLabel: "Generate specification",
    blurb:
      "Business framing — what we're building and why. Answer in plain language; no technology " +
      "here. Anything you leave blank comes back marked [NEEDS CLARIFICATION] rather than guessed.",
  },
  {
    stage: "plan",
    label: "2 · Plan",
    buttonLabel: "Generate plan",
    blurb:
      "The Tech Lead's step. These fields become the plan's Technical Context — the stack, " +
      "storage, and constraints the task breakdown and the seeded repository are derived from.",
    requires: "specify",
  },
  {
    stage: "tasks",
    label: "3 · Tasks",
    buttonLabel: "Generate tasks",
    blurb:
      "Derived automatically from the specification and the plan — no input needed. Generating " +
      "creates the task graph developers pick up.",
    requires: "plan",
  },
];

// Tabs group stages; they are not one-to-one with them. The constitution is
// its own document server-side (.specify/memory/constitution.md, its own
// generate call) but it is the Tech Lead's to write, so it sits inside their
// step rather than as a step of its own a business user has to step past.
type TabMeta = { key: string; label: string; stages: StageKind[]; techLeadOnly?: boolean };

const TABS: TabMeta[] = [
  { key: "specify", label: "1 · Specify", stages: ["specify"] },
  { key: "plan", label: "2 · Plan", stages: ["constitution", "plan"], techLeadOnly: true },
  { key: "tasks", label: "3 · Tasks", stages: ["tasks"] },
];

const STAGE_META: Record<string, StageMeta> = Object.fromEntries(
  STAGE_ORDER.map((meta) => [meta.stage, meta]),
);

// The cloud's own ordering errors (app/api/generation.py), which arrive as raw
// detail codes.
const STAGE_ERROR_TEXT: Record<string, string> = {
  requirement_required: "Generate the specification first — the plan is written against it.",
  spec_document_required: "Generate the plan first — the task breakdown is derived from it.",
  model_connection_not_configured:
    "No model is configured for this workspace, so generation is unavailable.",
  managed_tier_rate_limited: "The shared model is busy right now — try again in a moment.",
  daily_token_budget_exceeded: "This workspace hit its daily generation budget.",
};

// One stepper section. The input surface is stage-shaped: `specify` and `plan`
// get a structured form (STAGE_FIELDS), `tasks` gets no input at all because
// it is generated from the two documents above it.
function StageSection({
  projectId,
  stage,
  label,
  buttonLabel,
  blurb,
  blockedBy,
  onDocPresence,
  readOnly = false,
}: {
  projectId: string;
  stage: StageKind;
  label: string;
  buttonLabel: string;
  blurb: string;
  blockedBy?: string;
  onDocPresence?: (stage: StageKind, present: boolean) => void;
  readOnly?: boolean;
}) {
  const { authHeaders } = useAuth();
  const fields = STAGE_FIELDS[stage];
  const [answers, setAnswers] = useState<StageAnswers>({});
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
        onDocPresence?.(stage, doc.content.trim().length > 0);
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
      onDocPresence?.(stage, result.content.trim().length > 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, result, stage]);

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
      // The save projects the document onto the graph server-side, so a
      // hand-written stage unlocks the next one without a reload.
      onDocPresence?.(stage, doc.content.trim().length > 0);
    } catch (err) {
      setDocError((err as Error).message);
    } finally {
      setDocSaving(false);
    }
  }

  // `tasks` sends a fixed instruction instead of user text: the spec and plan
  // are injected server-side as context, so there is nothing left to ask.
  const userInput = fields ? composeStageInput(fields, answers) : TASKS_INPUT;
  const ready = fields ? requiredFieldsFilled(fields, answers) : true;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">{label}</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">{blurb}</p>
      {!readOnly && (
        <>
          {blockedBy && (
            <p className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">{blockedBy}</p>
          )}
          {fields && (
            <div className="mb-3">
              <StageInputForm
                projectId={projectId}
                stage={stage}
                fields={fields}
                answers={answers}
                onChange={setAnswers}
                disabled={status === "generating" || Boolean(blockedBy)}
                canPrefill={PREFILLABLE_STAGES.includes(stage)}
              />
            </div>
          )}
          <button
            type="button"
            disabled={status === "generating" || !ready || Boolean(blockedBy)}
            onClick={() => generate(stage, userInput)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-60"
          >
            {status === "generating" ? "Generating…" : buttonLabel}
          </button>
          {!ready && !blockedBy && (
            <p className="mt-2 text-xs text-slate-500">
              Fill in the fields marked * to generate.
            </p>
          )}

          {status === "generating" && streamedText && (
            <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
              {streamedText}
            </pre>
          )}
          {status === "error" && error && (
            <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
              <p>{STAGE_ERROR_TEXT[error.error] ?? error.error}</p>
              {error.retryable && (
                <button
                  type="button"
                  onClick={() => generate(stage, userInput)}
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
                onClick={() => generate(stage, userInput)}
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

// The uploaded PRD is what every later stage is generated from, so it stays
// visible — and previewable — in every lifecycle state, not just while the
// business user is still uploading. A Tech Lead reviewing the project reads
// the source document here rather than asking for it out of band.
function SourceDocuments({ projectId, canUpload }: { projectId: string; canUpload: boolean }) {
  const { authHeaders } = useAuth();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [documentsError, setDocumentsError] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  // Uploads persist server-side, so the list is read back on mount rather than
  // being rebuilt from whatever this tab uploaded. Without it a refresh showed
  // an empty dropzone and users re-uploaded a PRD that was already extracted.
  useEffect(() => {
    let cancelled = false;
    listDocuments(projectId, authHeaders())
      .then((docs) => {
        if (cancelled) return;
        setDocuments(docs);
        setDocumentsError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDocumentsError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const preview = documents.find((d) => d.id === previewId) ?? null;

  if (!canUpload && documents.length === 0 && !documentsError) return null;

  return (
    <div className="space-y-3">
      {canUpload && (
        <DocumentUpload
          projectId={projectId}
          onUploaded={(doc) =>
            setDocuments((prev) => [...prev.filter((d) => d.id !== doc.id), doc])
          }
        />
      )}
      {documentsError && (
        <p className="text-xs text-amber-700">
          Couldn&apos;t load previously uploaded documents — reload before uploading again to
          avoid a duplicate.
        </p>
      )}
      {documents.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-500">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span>
                {d.title} — {d.status}
                {d.status === "failed" && " (couldn't extract text — try a text-based export)"}
              </span>
              <button
                type="button"
                onClick={() => setPreviewId(previewId === d.id ? null : d.id)}
                // Named per file: the stage editors below carry their own
                // Raw/Preview toggle, so a bare "Preview" is ambiguous both to
                // a screen reader and to anything querying by accessible name.
                aria-label={`${previewId === d.id ? "Hide" : "Preview"} ${d.title}`}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:border-slate-400"
              >
                {previewId === d.id ? "Hide" : "Preview"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <DocumentPreview
          projectId={projectId}
          document={preview}
          onClose={() => setPreviewId(null)}
        />
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
  const { authHeaders, user } = useAuth();
  const [active, setActive] = useState<string>("specify");

  // "Tech Lead" is the workspace admin role — there is no separate role in the
  // schema (app/models/schemas.py's Role is admin | member), and the cloud
  // enforces the same rule on every plan-authoring endpoint
  // (app/api/_guards.py::require_stage_access).
  const { data: members } = useCloudGet<WorkspaceMember[]>(
    `/workspaces/${project.workspace_id}/members`,
  );
  const isTechLead = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

  // Which stages already have a saved document. Each stage reports its own
  // after loading, and the next stage stays locked until then — the same
  // ordering the cloud enforces, said before the request instead of after it.
  const [docPresent, setDocPresent] = useState<Partial<Record<StageKind, boolean>>>({});
  const notePresence = useCallback((stage: StageKind, present: boolean) => {
    setDocPresent((prev) => (prev[stage] === present ? prev : { ...prev, [stage]: present }));
  }, []);

  // Only the finished project is frozen. Earlier states stay editable: the
  // explicit "Send to Tech Lead" handoff is gone, so there is no moment at
  // which a business user deliberately locks their own specification, and
  // freezing during tech review would disable the Plan step in exactly the
  // state it exists for.
  const readOnly = project.lifecycle_status === "repo_created";

  const advanced = useRef(false);
  const lifecycle = project.lifecycle_status;

  // Opening the Plan step *is* the handoff. A Tech Lead working on the plan is
  // the event the lifecycle used to model with a button the business user had
  // to remember to press; both transitions are fire-and-forget because the
  // cloud rejects an out-of-order one and nothing here depends on the result.
  useEffect(() => {
    if (active !== "plan" || !isTechLead || advanced.current) return;
    if (lifecycle !== "planning" && lifecycle !== "pending_tech_review") return;
    advanced.current = true;
    (async () => {
      if (lifecycle === "planning") {
        await apiFetch(`/projects/${projectId}/lifecycle/submit-for-review`, authHeaders(), {
          method: "POST",
        }).catch(() => undefined);
      }
      await startTechReview(projectId, authHeaders()).catch(() => undefined);
      onChange();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, isTechLead, lifecycle, projectId]);

  // Undefined means "not loaded yet" — only an explicit false locks, so an
  // in-flight fetch doesn't flash a lock message on a project that has one.
  function blockedBy(meta: StageMeta): string | undefined {
    if (!meta.requires || docPresent[meta.requires] !== false) return undefined;
    const previous = STAGE_ORDER.find((s) => s.stage === meta.requires);
    return `Waiting on ${previous?.label ?? meta.requires} — generate that document first.`;
  }

  // Every stage stays mounted so a half-typed intake form survives switching
  // tabs; the inactive ones are hidden rather than unmounted.
  const visible = TABS.filter((tab) => !tab.techLeadOnly || isTechLead);

  return (
    <div className="space-y-4">
      {lifecycle === "repo_created" && (
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
      )}

      <SourceDocuments projectId={projectId} canUpload={!readOnly} />

      <div role="tablist" aria-label="Spec Kit stages" className="flex gap-1 border-b border-slate-200">
        {visible.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            onClick={() => setActive(tab.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${
              active === tab.key
                ? "border-slate-900 font-medium text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {visible.map((tab) => (
        <div key={tab.key} hidden={active !== tab.key} className="space-y-4">
          {tab.stages.map((stage) => {
            const meta = STAGE_META[stage];
            return (
              <StageSection
                key={stage}
                projectId={projectId}
                stage={stage}
                label={meta.label}
                buttonLabel={meta.buttonLabel}
                blurb={meta.blurb}
                blockedBy={readOnly ? undefined : blockedBy(meta)}
                onDocPresence={notePresence}
                readOnly={readOnly}
              />
            );
          })}
          {/* Creating the repository is a technical act on technical
              artifacts, so it lives with the Tech Lead's own step rather than
              at the bottom of a page a business user also reads. */}
          {tab.key === "plan" && lifecycle === "tech_review" && (
            <CreateRepositoryPanel
              projectId={projectId}
              projectName={project.name}
              onCreated={onChange}
            />
          )}
        </div>
      ))}
    </div>
  );
}
