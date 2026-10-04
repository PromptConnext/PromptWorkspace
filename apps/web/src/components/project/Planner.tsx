// apps/web/src/components/project/Planner.tsx
"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  apiFetch,
  getRepoAnalysis,
  getStageDocument,
  listDocuments,
  startTechReview,
  updateStageDocument,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import { DocumentUpload } from "./DocumentUpload";
import { DocumentPreview } from "./DocumentPreview";
import { DeploymentTemplatePanel } from "./DeploymentTemplatePanel";
import { PolicyScopePanel } from "./PolicyScopePanel";
import { useStageGeneration } from "./useStageGeneration";
import { StageInputForm, type PrefillOption } from "./StageInputForm";
import {
  composeStageInput,
  PREFILLABLE_STAGES,
  requiredFieldsFilled,
  STAGE_FIELDS,
  TASKS_INPUT,
  type StageAnswers,
} from "./stage-forms";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { stripStreamFence } from "@/lib/planner-sse";
import { ApprovalControl } from "./ApprovalControl";
import { CreateRepositoryPanel } from "./CreateRepositoryPanel";
import { CODEBASE_ANALYSIS_ANCHOR, CodebaseAnalysisPanel } from "./CodebaseAnalysisPanel";
import { DEPLOY_WORKFLOW_PATH, hasDeploymentTemplate, hasPolicyScope, SEEDED_FILES } from "./seedFiles";
import type {
  DocumentOut,
  Project,
  ProjectionState,
  RepoAnalysisOut,
  StageKind,
  WorkspaceMember,
} from "@/lib/types";

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
    label: "Project rules (do this first)",
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
    label: "Implementation plan",
    buttonLabel: "Generate plan",
    blurb:
      "Then this — the plan is written against the specification and the rules above. These fields become the plan's Technical Context — the stack, " +
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
//
// Every tab is shown to every project member. The Plan step used to be hidden
// from non-admins entirely, which read as a missing step ("0, 1, 3") and left
// Tasks as a dead end: it is not admin-only server-side, so a business user
// could press Generate and get the cloud's `spec_document_required` with no
// visible way to fix it. Authorship, not visibility, is what the role gates
// (ADMIN_ONLY_STAGES below) — matching the cloud, which lets anyone read.
type TabMeta = { key: string; label: string; title: string; stages: StageKind[] };

const TABS: TabMeta[] = [
  // Planning *inputs* — the PRD upload and the policy scope — live one step
  // before the first generated document, so the numbered strip reads as the
  // order the work actually happens in.
  { key: "foundation", label: "0 · Foundation", title: "Foundation", stages: [] },
  { key: "specify", label: "1 · Specify", title: "Specify", stages: ["specify"] },
  { key: "plan", label: "2 · Plan", title: "Plan", stages: ["constitution", "plan"] },
  { key: "tasks", label: "3 · Tasks", title: "Tasks", stages: ["tasks"] },
  // Last on purpose: creating the repository seeds it with the documents the
  // earlier steps produced, so it can only be the final act.
  { key: "repository", label: "4 · Repository", title: "Repository", stages: [] },
];

// The one action a stage panel wants next, and everything else beside it.
const PRIMARY_BUTTON =
  "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " +
  "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY_BUTTON =
  "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

// Names each stage editor for a screen reader, which otherwise met an
// unlabeled textbox.
const EDITOR_LABEL: Partial<Record<StageKind, string>> = {
  constitution: "Project rules document",
  specify: "Specification document",
  plan: "Implementation plan document",
  tasks: "Tasks document",
};

const PLAN_HELPER = "Not technical? Use Suggest from Spec, then review.";
// Advice, not a lock: generate/plan runs without a constitution
// (app/api/generation.py only folds one in when it exists).
const CONSTITUTION_RECOMMENDATION =
  "Recommended: generate the project rules first — the plan follows them when they exist.";

const STAGE_META: Record<string, StageMeta> = Object.fromEntries(
  STAGE_ORDER.map((meta) => [meta.stage, meta]),
);

// Mirrors apps/cloud/app/api/_guards.py::ADMIN_ONLY_STAGES. Reading is never
// gated there — a business user can open these, they just can't author them —
// so this only turns the section read-only rather than hiding it.
const ADMIN_ONLY_STAGES: StageKind[] = ["constitution", "plan"];

const TECH_LEAD_NOTE =
  "Your Tech Lead writes this step. You can read it here once they generate it.";

// The cloud's own ordering errors (app/api/generation.py), which arrive as raw
// detail codes.
const STAGE_ERROR_TEXT: Record<string, string> = {
  requirement_required: "Generate the specification first — the plan is written against it.",
  spec_document_required: "Save or generate the plan first — the task breakdown is derived from it.",
  model_connection_not_configured:
    "No model is configured for this workspace, so generation is unavailable.",
  managed_tier_rate_limited: "The shared model is busy right now — try again in a moment.",
  daily_token_budget_exceeded: "This workspace hit its daily generation budget.",
  // Raw error strings from apps/cloud/app/generation/stage_apply.py, surfaced
  // verbatim by a manual save's projection="failed" response — mapped here so
  // the amber block says what actually went wrong instead of a hardcoded
  // guess (plan 0018 review finding).
  "a plan needs a specification to be a plan for":
    "Save or generate the specification first — the plan is written against it.",
  "tasks document contained no parseable '- [ ] T###' checklist lines":
    "Every line needs the `- [ ] T001 Description` shape — check the checklist formatting.",
  graph_write_failed: "Something went wrong applying this to the project — try saving again.",
  // Plan 0027: an imported project's plan and tasks wait on a codebase
  // baseline (app/api/generation.py). The section also offers the way there.
  repo_analysis_required:
    "Analyze the repository first — this project was imported, so the plan and tasks are written " +
    "against its existing code.",
};

// Plan 0027's gate, said before the request rather than after its 409.
const ANALYSIS_GATE_TEXT =
  "Analyze the repository first — this project was imported, so the plan and tasks are written " +
  "against its existing code. The analysis is on the Foundation tab.";
const ANALYSIS_GATE_MEMBER_TEXT =
  "Waiting on the codebase analysis — your Tech Lead runs it on the Foundation tab.";

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
  note,
  onDocPresence,
  onOpenTasks,
  analysisGate,
  onOpenAnalysis,
  readOnly = false,
  helper,
  recommendation,
  prefill,
  prefillHint,
}: {
  projectId: string;
  stage: StageKind;
  label: string;
  buttonLabel: string;
  blurb: string;
  blockedBy?: string;
  /** Why this section is read-only, when it is read-only for a reason the
   *  viewer can't act on (a stage that belongs to someone else's role).
   *  Without it a non-author sees an unexplained empty editor. */
  note?: string;
  onDocPresence?: (stage: StageKind, present: boolean) => void;
  /** Switches the page to its Tasks tab, so a document the graph rejected can
   *  be checked against the board it failed to move. */
  onOpenTasks?: () => void;
  /** Why generation waits on the codebase analysis of an imported project
   *  (plan 0027), when it does. Locks generation like `blockedBy`, but comes
   *  with a way to the analysis panel. */
  analysisGate?: string;
  /** Switches to the Foundation tab's codebase analysis panel. */
  onOpenAnalysis?: () => void;
  readOnly?: boolean;
  /** One line under the heading for whoever isn't sure how to fill the form. */
  helper?: string;
  /** Advice that doesn't lock anything — e.g. an earlier step worth doing first. */
  recommendation?: string;
  prefill?: PrefillOption;
  prefillHint?: ReactNode;
}) {
  const { authHeaders } = useAuth();
  const fields = STAGE_FIELDS[stage];
  const [answers, setAnswers] = useState<StageAnswers>({});
  // Saves the form's pending answers now rather than after the debounce.
  const flushAnswers = useRef<(() => void) | null>(null);
  const { status, streamedText, result, error, generate } = useStageGeneration(projectId);

  const [docContent, setDocContent] = useState("");
  const [docLoaded, setDocLoaded] = useState(false);
  const [docSaving, setDocSaving] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docUpdatedAt, setDocUpdatedAt] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // What the last save reported about the graph. A GET can't tell us this (the
  // server has no projection to report for a read), so it stays null until this
  // session writes something.
  const [docProjection, setDocProjection] = useState<ProjectionState | null>(null);
  // Why the last save's projection failed, and how many tasks it retired —
  // both null until this session writes something, same as docProjection.
  const [docProjectionError, setDocProjectionError] = useState<string | null>(null);
  const [docRetiredCount, setDocRetiredCount] = useState<number | null>(null);

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
      setDocProjection(result.projection ?? null);
      setDocRetiredCount(result.retired_count ?? null);
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
      // hand-written stage unlocks the next one without a reload — and says
      // whether that projection actually happened rather than leaving the
      // saved-at line to imply it.
      setDocProjection(doc.projection);
      setDocProjectionError(doc.error ?? null);
      setDocRetiredCount(doc.retired_count ?? null);
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
  // Until the stage has a document, generating it is the thing to do here;
  // after that the tab's "Continue to …" takes over as the primary action.
  const hasDoc = docContent.trim().length > 0;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">{label}</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">{blurb}</p>
      {helper && !readOnly && <p className="mb-3 text-xs text-slate-600">{helper}</p>}
      {note && <p className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">{note}</p>}
      {!readOnly && (
        <>
          {blockedBy && (
            <p className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">{blockedBy}</p>
          )}
          {recommendation && !blockedBy && (
            <p className="mb-3 rounded bg-sky-50 p-3 text-xs text-sky-900">{recommendation}</p>
          )}
          {analysisGate && (
            <div className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">
              <p>{analysisGate}</p>
              {onOpenAnalysis && (
                <button
                  type="button"
                  onClick={onOpenAnalysis}
                  className="mt-2 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:border-slate-400"
                >
                  Go to codebase analysis
                </button>
              )}
            </div>
          )}
          {fields && (
            <div className="mb-3">
              <StageInputForm
                projectId={projectId}
                stage={stage}
                fields={fields}
                answers={answers}
                onChange={setAnswers}
                disabled={status === "generating" || Boolean(blockedBy) || Boolean(analysisGate)}
                canPrefill={PREFILLABLE_STAGES.includes(stage)}
                prefill={prefill}
                prefillHint={prefillHint}
                flushRef={flushAnswers}
              />
            </div>
          )}
          <button
            type="button"
            disabled={
              status === "generating" || !ready || Boolean(blockedBy) || Boolean(analysisGate)
            }
            onClick={() => {
              flushAnswers.current?.();
              generate(stage, userInput);
            }}
            className={hasDoc ? SECONDARY_BUTTON : PRIMARY_BUTTON}
          >
            {status === "generating" ? "Generating…" : buttonLabel}
          </button>
          {!ready && !blockedBy && !analysisGate && (
            <p className="mt-2 text-xs text-slate-500">
              Fill in the fields marked * to generate.
            </p>
          )}

          {status === "generating" && streamedText && (
            <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
              {stripStreamFence(streamedText)}
            </pre>
          )}
          {status === "error" && error && (
            <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
              <p>{STAGE_ERROR_TEXT[error.error] ?? error.error}</p>
              {error.error === "repo_analysis_required" && onOpenAnalysis && (
                <button
                  type="button"
                  onClick={onOpenAnalysis}
                  className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs"
                >
                  Go to codebase analysis
                </button>
              )}
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
                ? `${result.task_count} tasks on the board`
                : "Saved as a draft"}
              {Boolean(result.retired_count) && `, ${result.retired_count} retired`}
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
            label={EDITOR_LABEL[stage]}
          />
          {docUpdatedAt && (
            <p className="mt-1 text-xs text-slate-500">
              Last saved {new Date(docUpdatedAt).toLocaleString()}
              {docProjection === "current" &&
                Boolean(docRetiredCount) &&
                ` — ${docRetiredCount} task${docRetiredCount === 1 ? "" : "s"} retired`}
            </p>
          )}
          {/* "Last saved" used to be the only signal either write path gave,
              and it says nothing about the board the document is supposed to
              drive. A failed projection is the one case where the two
              disagree, so it is the one case that needs saying out loud —
              amber, like a truncated generation above, because the text is
              safe and the work is not finished. */}
          {docProjection === "failed" && (
            <div className="mt-2 rounded bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-medium">The task board didn&apos;t update</p>
              <p className="mt-1">
                {(docProjectionError && STAGE_ERROR_TEXT[docProjectionError]) ||
                  docProjectionError ||
                  "This document is saved, but nothing in it could be applied to the project graph — the board still shows what it showed before."}
              </p>
              {onOpenTasks && (
                <button
                  type="button"
                  onClick={onOpenTasks}
                  className="mt-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs"
                >
                  Open the task board
                </button>
              )}
            </div>
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
function SourceDocuments({
  projectId,
  canUpload,
  onPrdPresence,
}: {
  projectId: string;
  canUpload: boolean;
  /** Whether any upload has extracted text — what "Draft from PRD" reads. */
  onPrdPresence?: (present: boolean) => void;
}) {
  const { authHeaders } = useAuth();
  const [documents, setDocuments] = useState<DocumentOut[]>([]);
  const [documentsError, setDocumentsError] = useState(false);
  const [documentsLoading, setDocumentsLoading] = useState(true);
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
      })
      .finally(() => {
        if (!cancelled) setDocumentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const hasPrd = documents.some((d) => d.status === "extracted");
  useEffect(() => {
    if (!documentsLoading) onPrdPresence?.(hasPrd);
  }, [documentsLoading, hasPrd, onPrdPresence]);

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
      {/* Said, rather than left blank: an empty gap where a file is about to
          appear reads as "nothing uploaded", which is what made people upload
          the same PRD twice. */}
      {documentsLoading && (
        <p className="text-xs text-slate-500">Loading uploaded documents…</p>
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
  onOpenTasks,
}: {
  project: Project;
  projectId: string;
  onChange: () => void;
  /** Switches the page to its Tasks tab — the board the generated tasks land
   *  on. Optional so the Planner still renders standalone in tests. */
  onOpenTasks?: () => void;
}) {
  const { authHeaders, user } = useAuth();
  const [active, setActive] = useState<string>("foundation");

  // "Tech Lead" is the workspace admin role — there is no separate role in the
  // schema (app/models/schemas.py's Role is admin | member), and the cloud
  // enforces the same rule on every plan-authoring endpoint
  // (app/api/_guards.py::require_stage_access).
  const {
    data: members,
    loading: membersLoading,
    error: membersError,
    refetch: refetchMembers,
  } = useCloudGet<WorkspaceMember[]>(`/workspaces/${project.workspace_id}/members`);
  const isTechLead = !!members?.some((m) => m.user_id === user?.id && m.role === "admin");

  // Which stages already have a saved document. Each stage reports its own
  // after loading, and the next stage stays locked until then — the same
  // ordering the cloud enforces, said before the request instead of after it.
  const [docPresent, setDocPresent] = useState<Partial<Record<StageKind, boolean>>>({});
  const notePresence = useCallback((stage: StageKind, present: boolean) => {
    setDocPresent((prev) => (prev[stage] === present ? prev : { ...prev, [stage]: present }));
  }, []);
  // Whether an uploaded PRD has text to draft from. Undefined while the
  // document list loads, so neither the draft button nor its "upload one
  // first" hint flashes up before it is known which applies.
  const [hasPrd, setHasPrd] = useState<boolean | undefined>(undefined);

  // The "Continue to …" buttons: switch the tab and bring the strip — and
  // keyboard focus — to it, since the button pressed lived on the panel that
  // just hid.
  const goTo = useCallback((key: string) => {
    setActive(key);
    requestAnimationFrame(() => {
      const tab = document.getElementById(`planner-tab-${key}`);
      tab?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      tab?.focus();
    });
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
    if ((active !== "plan" && active !== "repository") || !isTechLead || advanced.current) return;
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

  // Plan 0027. Read only for a project that could need it — one that names a
  // repository before `repo_created`, i.e. an imported one — and owned here
  // rather than in the panel, because the Plan and Tasks tabs gate on it
  // too. Null while loading or after a failed read: neither locks anything,
  // and the cloud's own 409 repo_analysis_required still stands behind it.
  const [analysis, setAnalysis] = useState<RepoAnalysisOut | null>(null);
  const analysisApplies = Boolean(project.repo_url) && lifecycle !== "repo_created";
  useEffect(() => {
    if (!analysisApplies) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    getRepoAnalysis(projectId, authHeaders())
      .then((result) => {
        if (!cancelled) setAnalysis(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, analysisApplies]);
  const analysisRequired = analysis?.required === true;
  const analysisGate =
    analysisRequired && analysis?.status !== "baseline_ready"
      ? isTechLead
        ? ANALYSIS_GATE_TEXT
        : ANALYSIS_GATE_MEMBER_TEXT
      : undefined;

  const openAnalysis = useCallback(() => {
    setActive("foundation");
    // After the tab's `hidden` lifts, or there is nothing laid out to scroll to.
    requestAnimationFrame(() => {
      document.getElementById(CODEBASE_ANALYSIS_ANCHOR)?.scrollIntoView?.({ behavior: "smooth" });
    });
  }, []);

  // Undefined means "not loaded yet" — only an explicit false locks, so an
  // in-flight fetch doesn't flash a lock message on a project that has one.
  function blockedBy(meta: StageMeta): string | undefined {
    if (!meta.requires || docPresent[meta.requires] !== false) return undefined;
    const previous = STAGE_ORDER.find((s) => s.stage === meta.requires);
    const label = previous?.label ?? meta.requires;
    // Telling a business user to "generate that document first" points them at
    // a stage only a Tech Lead may author, so name who does it instead.
    if (ADMIN_ONLY_STAGES.includes(meta.requires) && !isTechLead) {
      return `Waiting on ${label} — your Tech Lead generates it.`;
    }
    return `Waiting on ${label} — generate it first.`;
  }

  // What each tab's progress mark reads. Foundation's inputs are optional, so
  // it counts as done once either one is given.
  function tabDone(key: string): boolean {
    switch (key) {
      case "foundation":
        if (analysisRequired && analysis?.status !== "baseline_ready") return false;
        return hasPolicyScope(project) || hasPrd === true;
      case "specify":
        return docPresent.specify === true;
      case "plan":
        return docPresent.plan === true;
      case "tasks":
        return docPresent.tasks === true;
      case "repository":
        return lifecycle === "repo_created";
      default:
        return false;
    }
  }

  // The draft button is one prefill call (app/api/generation.py::prefill); it
  // is named after what that call will actually read. Specify reads uploads
  // (and an imported project's codebase baseline); Plan reads those plus the
  // specification, which is the better source once it exists.
  const baselineReady = analysis?.status === "baseline_ready";
  function prefillFor(stage: StageKind): PrefillOption | undefined {
    const editNote = " — yours to edit.";
    if (stage === "plan" && docPresent.specify) {
      return {
        label: "Suggest from Spec",
        busyLabel: "Reading the specification…",
        ariaLabel: "Suggest the plan fields from the specification",
        description: `Fills the blank fields from the specification${hasPrd ? " and the PRD" : ""}${editNote}`,
      };
    }
    if (hasPrd) {
      return {
        label: "Draft from PRD",
        busyLabel: "Reading the PRD…",
        ariaLabel: `Draft the ${stage} fields from the PRD`,
        description: `Fills the blank fields from the uploaded document${editNote}`,
        noSourceError:
          "The uploaded PRD has no readable text (scanned PDF?). Upload a text PDF or Markdown.",
      };
    }
    if (baselineReady) {
      return {
        label: "Draft from codebase",
        busyLabel: "Reading the codebase…",
        ariaLabel: `Draft the ${stage} fields from the codebase baseline`,
        description: `Fills the blank fields from the repository analysis${editNote}`,
      };
    }
    if (stage === "plan" && hasPrd === false) {
      return {
        label: "Suggest from Spec",
        busyLabel: "Reading the specification…",
        ariaLabel: "Suggest the plan fields from the specification",
        description: "",
        disabledReason:
          "Nothing to suggest from yet — write the specification (or upload a PRD in Foundation) first.",
      };
    }
    return undefined;
  }
  const specifyPrefillHint =
    hasPrd === false && !baselineReady ? (
      <>
        <button
          type="button"
          onClick={() => goTo("foundation")}
          className="rounded underline hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Upload a PRD in Foundation
        </button>{" "}
        to draft these answers automatically.
      </>
    ) : undefined;

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
          {/* The fixed list is exact only for a repository the platform
              created. An imported one kept its own files (plan 0027 M4), so
              which paths were written depended on its tree at the time — say
              the rule rather than list paths that may not be there. */}
          {project.repo_origin === "imported" ? (
            <p className="mt-2 text-emerald-800">
              PromptWorkspace added its planning documents in one commit. Existing files were left
              untouched; where a document would have landed on one, it went under
              docs/promptworkspace/ instead.
            </p>
          ) : (
            <>
              <p className="mt-2 text-emerald-800">Seeded files:</p>
              <ul className="ml-4 list-disc text-emerald-800">
                {SEEDED_FILES.map((path) => (
                  <li key={path}>{path}</li>
                ))}
                {hasPolicyScope(project) && <li>docs/policy-scope.md</li>}
                {hasDeploymentTemplate(project) && <li>{DEPLOY_WORKFLOW_PATH}</li>}
              </ul>
            </>
          )}
          <p className="mt-2">Developers can now clone this repo and open it in the PromptWorkspace VS Code extension.</p>
        </div>
      )}

      {/* The strip is the same for every member, but what the panels below it
          allow is not, so it still waits for the membership fetch rather than
          offering an authorable Plan step and locking it a moment later. The
          `!user` arm covers useCloudGet's early return while the session is
          still resolving, which otherwise reports a real admin as a member.
          One placeholder of the same height keeps the panel from jumping. */}
      {/* A roster that never arrived is not the same as "you are not an admin",
          but `isTechLead` collapses both to false. Say so rather than silently
          serving the reduced surface. */}
      {membersError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            Couldn&apos;t load the workspace members, so Tech Lead controls are unavailable here.
          </p>
          <button
            type="button"
            onClick={refetchMembers}
            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {membersLoading || (!user && !membersError) ? (
        <div
          aria-hidden
          className="h-[41px] animate-pulse border-b border-slate-200 bg-slate-50"
        />
      ) : (
      <div role="tablist" aria-label="Spec Kit stages" className="flex gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-slate-200">
        {TABS.map((tab) => {
          const done = tabDone(tab.key);
          const current = active === tab.key;
          return (
            <button
              key={tab.key}
              id={`planner-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={current}
              aria-controls={`planner-panel-${tab.key}`}
              data-status={done ? "done" : current ? "current" : "not-started"}
              onClick={() => setActive(tab.key)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 ${
                current
                  ? "border-slate-900 font-medium text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {/* Progress at a glance: a check once the step has produced
                  something, a hollow ring before (filled while it is the
                  open tab). "current" is already aria-selected, so only
                  "completed" needs saying to a screen reader. */}
              {done ? (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5 shrink-0 text-emerald-600"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full border ${
                    current ? "border-slate-900 bg-slate-900" : "border-slate-400"
                  }`}
                />
              )}
              {tab.label}
              {done && <span className="sr-only"> completed</span>}
            </button>
          );
        })}
      </div>
      )}

      {/* Every stage stays mounted so a half-typed intake form survives
          switching tabs; the inactive ones are hidden rather than unmounted,
          which also keeps them out of the accessibility tree. */}
      {TABS.map((tab, index) => (
        <div
          key={tab.key}
          id={`planner-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`planner-tab-${tab.key}`}
          hidden={active !== tab.key}
          className="space-y-4"
        >
          {tab.key === "foundation" && (
            <>
              <p className="text-sm text-slate-600">
                Foundation is the background the later steps are written from: the PRD that
                describes the product, and the policies it must follow. Both parts are optional —
                skip straight to Specify if you have neither.
              </p>
              {/* First on the tab for an imported project: it is the one
                  input the later steps can't start without, and the tab a
                  fresh import lands on. */}
              {analysis && analysisRequired && (
                <CodebaseAnalysisPanel
                  projectId={projectId}
                  analysis={analysis}
                  canEdit={isTechLead}
                  onChange={setAnalysis}
                />
              )}
              <SourceDocuments
                projectId={projectId}
                canUpload={!readOnly}
                onPrdPresence={setHasPrd}
              />
              <PolicyScopePanel project={project} readOnly={readOnly} onChange={onChange} />
              <button type="button" onClick={() => goTo("specify")} className={PRIMARY_BUTTON}>
                Continue to Specify
              </button>
            </>
          )}
          {tab.stages.map((stage) => {
            const meta = STAGE_META[stage];
            const authorGated = ADMIN_ONLY_STAGES.includes(stage) && !isTechLead;
            // Tasks stay generatable after `repo_created`: they are graph rows
            // the board works from, not part of the seeded repository, and the
            // cloud does not refuse the stage there. Freezing them stranded a
            // project that reached the repo with no task graph.
            const stageReadOnly = (readOnly && stage !== "tasks") || authorGated;
            return (
              <StageSection
                key={stage}
                projectId={projectId}
                stage={stage}
                label={meta.label}
                buttonLabel={meta.buttonLabel}
                blurb={meta.blurb}
                blockedBy={stageReadOnly ? undefined : blockedBy(meta)}
                note={authorGated && !readOnly ? TECH_LEAD_NOTE : undefined}
                onDocPresence={notePresence}
                onOpenTasks={onOpenTasks}
                analysisGate={stage === "plan" || stage === "tasks" ? analysisGate : undefined}
                onOpenAnalysis={analysisRequired ? openAnalysis : undefined}
                readOnly={stageReadOnly}
                helper={stage === "plan" ? PLAN_HELPER : undefined}
                recommendation={
                  stage === "plan" && docPresent.constitution === false
                    ? CONSTITUTION_RECOMMENDATION
                    : undefined
                }
                prefill={PREFILLABLE_STAGES.includes(stage) ? prefillFor(stage) : undefined}
                prefillHint={stage === "specify" ? specifyPrefillHint : undefined}
              />
            );
          })}
          {/* The next step, said once this one has produced its document —
              after a generation or a save, and still there on the next visit.
              Generation is where the task graph is born and the board is where
              it is worked, so on Tasks the board comes first. */}
          {tab.stages.length > 0 && tabDone(tab.key) && TABS[index + 1] && (
            <div className="flex flex-wrap items-center gap-2">
              {(tab.key === "specify" || tab.key === "tasks") && (
                <ApprovalControl
                  projectId={projectId}
                  kind={tab.key === "specify" ? "intent_approval" : "plan_approval"}
                />
              )}
              {tab.key === "tasks" && onOpenTasks && (
                <button type="button" onClick={onOpenTasks} className={PRIMARY_BUTTON}>
                  Open the task board
                </button>
              )}
              <button
                type="button"
                onClick={() => goTo(TABS[index + 1].key)}
                className={tab.key === "tasks" && onOpenTasks ? SECONDARY_BUTTON : PRIMARY_BUTTON}
              >
                Continue to {TABS[index + 1].title}
              </button>
            </div>
          )}
          {tab.key === "repository" && !isTechLead && !readOnly && (
            <p className="rounded bg-slate-50 p-3 text-xs text-slate-600">
              Your Tech Lead creates the repository once the tasks are generated.
            </p>
          )}
          {/* Beside CreateRepositoryPanel because it configures exactly
              that act: the template is seeded by repo creation and frozen
              afterwards, so choosing it anywhere later would be too late.
              Rendered for the whole Tech Lead step rather than only in
              `tech_review`, so a frozen project still shows what it deployed
              with. */}
          {tab.key === "repository" && isTechLead && (
            <DeploymentTemplatePanel
              project={project}
              workspaceId={project.workspace_id}
              readOnly={readOnly}
              onChange={onChange}
            />
          )}
          {/* Creating the repository is a technical act on technical
              artifacts, so it lives with the Tech Lead's own step rather than
              at the bottom of a page a business user also reads. */}
          {tab.key === "repository" && isTechLead && lifecycle === "tech_review" && (
            <CreateRepositoryPanel
              projectId={projectId}
              projectName={project.name}
              onCreated={onChange}
              constitutionReady={docPresent.constitution}
              tasksReady={docPresent.tasks}
              workspaceId={project.workspace_id}
              project={project}
            />
          )}
        </div>
      ))}
    </div>
  );
}
