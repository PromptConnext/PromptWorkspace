// apps/web/src/components/project/StageSection.tsx
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  acceptStageDraft,
  ApiError,
  getStageDocument,
  rejectStageDraft,
  updateStageDocument,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { GenerationWarnings } from "./GenerationWarnings";
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
import { retiredLabel } from "./retiredLabel";
import { StageDraftBanner } from "./StageDraftBanner";
import type { ProjectionState, StageDraftOut, StageKind } from "@/lib/types";

// The one action a stage panel wants next, and everything else beside it.
export const PRIMARY_BUTTON =
  "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " +
  "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";
export const SECONDARY_BUTTON =
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

// The plan waits for the intent once approval has been asked for.
export const INTENT_WAITING_TEXT =
  "Waiting for the intent to be approved. The plan is written once the business owner approves it.";

// The cloud's own ordering errors (app/api/generation.py), which arrive as raw
// detail codes.
const STAGE_ERROR_TEXT: Record<string, string> = {
  requirement_required: "Generate the specification first — the plan is written against it.",
  intent_not_approved: INTENT_WAITING_TEXT,
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
    "Waiting for the codebase baseline — this project was imported, so the plan and tasks are " +
    "written against its code.",
};

// Plan 0027's gate, said before the request rather than after its 409. The
// baseline comes from the importer's local coding agent (start_planning over
// MCP), not from a button here.
export const ANALYSIS_GATE_TEXT =
  "Waiting for the codebase baseline — this project was imported, so the plan and tasks are " +
  "written against its code. Your coding agent submits it through the start_planning flow.";
export const ANALYSIS_GATE_MEMBER_TEXT =
  "Waiting for the codebase baseline — this project was imported, so the plan and tasks are " +
  "written against its code. A workspace admin's coding agent submits it.";

// The cloud refuses a draft accept with 403 when the caller may not author
// the stage (app/api/_guards.py::require_stage_access).
const DRAFT_FORBIDDEN_TEXT = "Only your Tech Lead can accept this draft.";

// The draft-specific refusals of an accept or reject. Checked before the
// stage's own error text, whose 409 copy names Generate, which an imported
// project does not offer.
const DRAFT_ERROR_TEXT: Record<string, string> = {
  draft_changed: "This draft changed since you opened it — reloading.",
  requirement_required: "Accept the specification draft first — the plan is written against it.",
  spec_document_required: "Accept the plan draft first — tasks are broken down from it.",
  intent_not_approved: INTENT_WAITING_TEXT,
};

// A refused accept or reject, in words. The 409s are the same ordering codes
// generation answers, reworded for a draft to accept rather than a document
// to generate. `analysisText` is the baseline-gate sentence for this viewer
// (an admin's agent submits the baseline; a member waits for one).
function draftErrorText(err: unknown, analysisText: string): string {
  if (err instanceof ApiError && err.status === 403) return DRAFT_FORBIDDEN_TEXT;
  const code = (err as Error).message;
  if (code === "repo_analysis_required") return analysisText;
  return DRAFT_ERROR_TEXT[code] ?? STAGE_ERROR_TEXT[code] ?? code;
}

export type StageSectionProps = {
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
  /** Reports the document's saved-at stamp whenever it changes (load, save,
   *  generation), so the approval chip beside the stage can refetch. */
  onDocStamp?: (stage: StageKind, stamp: string | null) => void;
  /** Called when a save or generation updated the graph from the document
   *  (`projection: "current"`), so the page reloads the board, the Delivery
   *  tab and the rest instead of showing the old tasks until its next poll. */
  onGraphChange?: () => void;
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
  /** Asked before a generation overwrites the document, when the repository
   *  already holds a copy of it (the project is at `repo_created`): the copy
   *  falls behind and has to be synced through a pull request. */
  confirmReplace?: string;
  /** An imported project, planned by the importer's local coding agent: the
   *  managed-model Generate and prefill controls are not offered; the editor
   *  and Save stay. */
  agentPlanned?: boolean;
  /** The agent's draft for this stage, pending or rejected. */
  draft?: StageDraftOut;
  /** Whether the viewer may accept or reject `draft`. */
  draftCanAct?: boolean;
  /** Why `draft` cannot be accepted yet (a missing predecessor, or the
   *  codebase baseline gate). */
  draftBlockedBy?: string;
  /** The baseline-gate sentence for this viewer, for a refused accept. */
  draftAnalysisText?: string;
  /** Called after an accept or reject, so the Planner rereads the drafts. */
  onDraftsChange?: () => void;
};

// One stepper section. The input surface is stage-shaped: `specify` and `plan`
// get a structured form (STAGE_FIELDS), `tasks` gets no input at all because
// it is generated from the two documents above it.
export function StageSection({
  projectId,
  stage,
  label,
  buttonLabel,
  blurb,
  blockedBy,
  note,
  onDocPresence,
  onDocStamp,
  onGraphChange,
  onOpenTasks,
  analysisGate,
  onOpenAnalysis,
  readOnly = false,
  helper,
  recommendation,
  prefill,
  prefillHint,
  confirmReplace,
  agentPlanned = false,
  draft,
  draftCanAct = false,
  draftBlockedBy,
  draftAnalysisText = ANALYSIS_GATE_TEXT,
  onDraftsChange,
}: StageSectionProps) {
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
  const [docRetiredRefs, setDocRetiredRefs] = useState<string[] | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // A pending draft is reviewed in the stage editor: its markdown is loaded
  // there in place of the stored document, and Accept sends whatever the
  // editor holds. Reset only when a different draft arrives, so a poll that
  // rereads the same draft does not throw away the reviewer's edits.
  const pendingDraft = draft?.status === "pending" ? draft : undefined;
  const [draftText, setDraftText] = useState(pendingDraft?.markdown ?? "");
  useEffect(() => {
    if (pendingDraft) setDraftText(pendingDraft.markdown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDraft?.id]);
  const editorText = pendingDraft ? draftText : docContent;
  const setEditorText = pendingDraft ? setDraftText : setDocContent;

  // Reported once the document has loaded, so every later change of stamp is
  // a save or a regeneration (the Planner refreshes the docs banner on those).
  useEffect(() => {
    if (docLoaded) onDocStamp?.(stage, docUpdatedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, docUpdatedAt, docLoaded]);

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
      setDocRetiredRefs(result.retired_refs ?? null);
      onDocPresence?.(stage, result.content.trim().length > 0);
      if (result.projection === "current") onGraphChange?.();
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
      // Save writes the stage document, as it always has — with a pending
      // draft open, that is the editor's text; the draft itself is untouched
      // and stays pending until it is accepted or rejected.
      const doc = await updateStageDocument(projectId, stage, editorText, authHeaders());
      setDocContent(doc.content);
      setDocUpdatedAt(doc.updated_at);
      // The save projects the document onto the graph server-side, so a
      // hand-written stage unlocks the next one without a reload — and says
      // whether that projection actually happened rather than leaving the
      // saved-at line to imply it.
      setDocProjection(doc.projection);
      setDocProjectionError(doc.error ?? null);
      setDocRetiredCount(doc.retired_count ?? null);
      setDocRetiredRefs(doc.retired_refs ?? null);
      onDocPresence?.(stage, doc.content.trim().length > 0);
      if (doc.projection === "current") onGraphChange?.();
    } catch (err) {
      setDocError((err as Error).message);
    } finally {
      setDocSaving(false);
    }
  }

  // Accepting a draft writes it as the stage document, so it lands the way a
  // save does: same projection report, same graph refresh. A failed
  // projection keeps the draft (it now carries last_error) and says why.
  async function acceptDraft() {
    if (!draft) return;
    setDraftError(null);
    try {
      const doc = await acceptStageDraft(projectId, stage, draft.id, draftText, authHeaders());
      setDocContent(doc.content);
      setDocUpdatedAt(doc.updated_at);
      setDocProjection(doc.projection);
      setDocProjectionError(doc.error ?? null);
      setDocRetiredCount(doc.retired_count ?? null);
      setDocRetiredRefs(doc.retired_refs ?? null);
      onDocPresence?.(stage, doc.content.trim().length > 0);
      if (doc.projection === "current") onGraphChange?.();
    } catch (err) {
      setDraftError(draftErrorText(err, draftAnalysisText));
    } finally {
      onDraftsChange?.();
    }
  }

  async function rejectDraft(note: string) {
    if (!draft) return;
    setDraftError(null);
    try {
      await rejectStageDraft(projectId, stage, draft.id, note, authHeaders());
    } catch (err) {
      setDraftError(draftErrorText(err, draftAnalysisText));
      // The banner keeps the typed note when the reject did not land.
      throw err;
    } finally {
      onDraftsChange?.();
    }
  }

  // `tasks` sends a fixed instruction instead of user text: the spec and plan
  // are injected server-side as context, so there is nothing left to ask.
  const userInput = fields ? composeStageInput(fields, answers) : TASKS_INPUT;
  const ready = fields ? requiredFieldsFilled(fields, answers) : true;
  const generateAfterConfirm = () => {
    if (confirmReplace && !window.confirm(confirmReplace)) return;
    generate(stage, userInput);
  };
  // Until the stage has a document, generating it is the thing to do here;
  // after that the tab's "Continue to …" takes over as the primary action.
  const hasDoc = docContent.trim().length > 0;
  // The banner beside a disabled Accept already says the baseline gate is
  // closed; the section does not say it a second time.
  const gateInBanner =
    Boolean(analysisGate) &&
    pendingDraft !== undefined &&
    draftCanAct &&
    draftBlockedBy === analysisGate;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">{label}</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">{blurb}</p>
      {helper && !readOnly && <p className="mb-3 text-xs text-slate-600">{helper}</p>}
      {note && <p className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">{note}</p>}
      {draft && (
        <StageDraftBanner
          draft={draft}
          canAct={draftCanAct}
          blockedBy={draftBlockedBy}
          onAccept={acceptDraft}
          onReject={rejectDraft}
        />
      )}
      {draftError && (
        <p role="alert" className="mb-3 rounded bg-red-50 p-3 text-sm text-red-700">
          {draftError}
        </p>
      )}
      {!readOnly && (
        <>
          {/* With a draft present the banner says it, beside the Accept it disables. */}
          {blockedBy && !draft && (
            <p className="mb-3 rounded bg-slate-50 p-3 text-xs text-slate-600">{blockedBy}</p>
          )}
          {recommendation && !blockedBy && (
            <p className="mb-3 rounded bg-sky-50 p-3 text-xs text-sky-900">{recommendation}</p>
          )}
          {analysisGate && !gateInBanner && (
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
          {fields && !agentPlanned && (
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
          {!agentPlanned && (
          <button
            type="button"
            disabled={
              status === "generating" || !ready || Boolean(blockedBy) || Boolean(analysisGate)
            }
            onClick={() => {
              flushAnswers.current?.();
              generateAfterConfirm();
            }}
            className={hasDoc ? SECONDARY_BUTTON : PRIMARY_BUTTON}
          >
            {status === "generating" ? "Generating…" : buttonLabel}
          </button>
          )}
          {!agentPlanned && !ready && !blockedBy && !analysisGate && (
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
                  onClick={generateAfterConfirm}
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
                onClick={generateAfterConfirm}
                className="mt-2 rounded border border-amber-300 bg-white px-2 py-1 text-xs"
              >
                Generate again
              </button>
            </div>
          )}
          {status === "done" && <GenerationWarnings warnings={result?.warnings} />}
          {status === "done" && result && (
            <p className="mt-2 text-xs text-slate-500">
              {result.task_count !== undefined
                ? `${result.task_count} tasks on the board`
                : "Saved as a draft"}
              {Boolean(result.retired_count) &&
                `, ${retiredLabel(result.retired_count ?? 0, result.retired_refs)}`}
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
            value={editorText}
            onChange={setEditorText}
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
                ` — ${retiredLabel(docRetiredCount ?? 0, docRetiredRefs)}`}
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
