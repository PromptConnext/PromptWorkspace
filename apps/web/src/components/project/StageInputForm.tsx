// apps/web/src/components/project/StageInputForm.tsx
"use client";

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { getStageInputs, prefillStage, putStageInputs } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  initialAnswers,
  stageDraftKey,
  type StageAnswers,
  type StageField,
} from "./stage-forms";
import type { StageKind } from "@/lib/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

const PREFILL_ERROR_TEXT: Record<string, string> = {
  no_source_material:
    "Nothing to read yet — upload a PRD (or write the specification) first.",
  prefill_unparseable: "The model didn't return a usable draft. Try again.",
  managed_tier_rate_limited: "The shared model is busy right now — try again in a moment.",
  daily_token_budget_exceeded: "This workspace hit its daily generation budget.",
  model_provider_error: "The model provider failed. Try again.",
};

/** What the draft button says and reads from. The prefill endpoint is one
 *  call either way; this is only how the Planner names it, so the label can
 *  say what the draft is actually drawn from (a PRD, or the specification). */
export type PrefillOption = {
  label: string;
  busyLabel: string;
  ariaLabel: string;
  description: string;
  /** Said instead of the generic text when the cloud 409s no_source_material. */
  noSourceError?: string;
  /** Set when there is nothing to draft from yet — the button stays visible
   *  but disabled, and this says why. */
  disabledReason?: string;
};

/** How long typing has to pause before the answers are saved to the cloud. */
export const AUTOSAVE_DELAY_MS = 800;

// The answers live in the cloud (GET/PUT /projects/{id}/stage-inputs/{stage}),
// so a teammate or another device reopens the form filled in and a
// regeneration is an edit rather than a retype. localStorage is only a cache
// of edits the cloud hasn't acknowledged yet: the draft itself, plus a flag
// saying it is ahead of the server. On load the server's answers win unless
// that flag is set. Nothing is written until the server's answers have been
// read, and a PUT replaces the stored answers wholesale — last writer wins, by
// design (see apps/cloud/app/api/stage_inputs.py) — so saves go one at a time.
function loadDraft(projectId: string, stage: StageKind): StageAnswers {
  try {
    const raw = localStorage.getItem(stageDraftKey(projectId, stage));
    return raw ? (JSON.parse(raw) as StageAnswers) : {};
  } catch {
    return {};
  }
}

function unsavedKey(projectId: string, stage: StageKind): string {
  return `${stageDraftKey(projectId, stage)}:unsaved`;
}

function hasUnsaved(projectId: string, stage: StageKind): boolean {
  try {
    return localStorage.getItem(unsavedKey(projectId, stage)) === "1";
  } catch {
    return false;
  }
}

function markUnsaved(projectId: string, stage: StageKind, unsaved: boolean) {
  try {
    if (unsaved) localStorage.setItem(unsavedKey(projectId, stage), "1");
    else localStorage.removeItem(unsavedKey(projectId, stage));
  } catch {
    // Losing the flag only means the server's copy wins on the next load.
  }
}

function hasContent(answers: StageAnswers): boolean {
  return Object.values(answers).some((v) => typeof v === "string" && v.trim().length > 0);
}

// Key order is not preserved by the server (jsonb), so compare sorted pairs.
function answersKey(answers: StageAnswers): string {
  return JSON.stringify(
    Object.keys(answers)
      .sort()
      .map((k) => [k, answers[k]]),
  );
}

/** "local": the cloud can't store answers yet (migration 0003 unapplied), so
 *  they wait on this device and upload on a later save. */
type SaveState = "idle" | "saving" | "saved" | "local" | "error";
type LoadState = "loading" | "loaded" | "failed";

/** Backoff between attempts to read the server's answers after a failure. */
const LOAD_RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export function StageInputForm({
  projectId,
  stage,
  fields,
  answers,
  onChange,
  disabled = false,
  canPrefill = true,
  prefill,
  prefillHint,
  flushRef,
}: {
  projectId: string;
  stage: StageKind;
  fields: StageField[];
  answers: StageAnswers;
  onChange: (next: StageAnswers) => void;
  disabled?: boolean;
  /** False for stages the prefill endpoint doesn't accept (see
   *  PREFILLABLE_STAGES) — the button is hidden rather than left to 422. */
  canPrefill?: boolean;
  /** The draft button, when there is something to draft from. */
  prefill?: PrefillOption;
  /** Said instead of the button when `prefill` is absent — e.g. where to
   *  upload the PRD the draft would read. */
  prefillHint?: ReactNode;
  /** Set to a function that saves pending answers right away — the Planner
   *  calls it when Generate is pressed, so the answers behind a generation
   *  don't wait out the debounce. */
  flushRef?: MutableRefObject<(() => void) | null>;
}) {
  const { authHeaders } = useAuth();
  const [hydrated, setHydrated] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);
  // Nothing is written until a read of the server's answers has succeeded, so
  // a stale local draft can never overwrite answers that were never seen.
  const [loadState, setLoadStateValue] = useState<LoadState>("loading");
  const loadStateRef = useRef<LoadState>("loading");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const answersRef = useRef(answers);
  answersRef.current = answers;
  // answersKey() of what the server holds; null until known.
  const serverKeyRef = useRef<string | null>(null);
  // Only answers somebody actually wrote are saved — opening the form must
  // not write its defaults back.
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-reads the server's answers now (set while a load is mounted).
  const retryLoadRef = useRef<(() => void) | null>(null);
  // The PUT in flight, if any, and whether another is wanted after it.
  const savingRef = useRef<Promise<void> | null>(null);
  const saveAgainRef = useRef(false);
  // Bumped per load, so a save that outlives a stage switch can't touch the
  // new stage's state.
  const loadGenRef = useRef(0);
  const defaultsKey = answersKey(initialAnswers(fields, {}));

  function setLoadState(next: LoadState) {
    loadStateRef.current = next;
    setLoadStateValue(next);
  }

  function save() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (loadStateRef.current !== "loaded") return;
    // One PUT at a time: the server replaces the row wholesale, so an older
    // request landing last would leave it on older answers.
    if (savingRef.current) {
      saveAgainRef.current = true;
      return;
    }
    const snapshot = answersRef.current;
    const key = answersKey(snapshot);
    const gen = loadGenRef.current;
    setSaveState("saving");
    savingRef.current = putStageInputs(projectId, stage, snapshot, authHeaders())
      .then(
        () => {
          if (gen !== loadGenRef.current) return;
          serverKeyRef.current = key;
          if (answersKey(answersRef.current) === key) markUnsaved(projectId, stage, false);
          setSaveState("saved");
        },
        (err) => {
          if (gen !== loadGenRef.current) return;
          // Not retryable until the migration is applied; the unsaved flag
          // stays, so the answers upload on a later save.
          setSaveState((err as Error).message === "stage_inputs_unavailable" ? "local" : "error");
        },
      )
      .finally(() => {
        savingRef.current = null;
        if (saveAgainRef.current) {
          saveAgainRef.current = false;
          if (pending()) saveRef.current();
        }
      });
  }
  // The latest render's save(), for work that outlives the render it began in.
  const saveRef = useRef(save);
  saveRef.current = save;

  function pending(): boolean {
    return dirtyRef.current && answersKey(answersRef.current) !== serverKeyRef.current;
  }

  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = () => {
      if (pending()) save();
    };
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const local = loadDraft(projectId, stage);
    // A draft that is only today's defaults is nothing anybody wrote; storing
    // it would freeze those defaults server-side.
    const localWritten =
      answersKey(initialAnswers(fields, local)) !== answersKey(initialAnswers(fields, {}));
    loadGenRef.current += 1;
    dirtyRef.current = false;
    serverKeyRef.current = null;
    setLoadState("loading");
    setSaveState("idle");
    onChange(initialAnswers(fields, local));
    setHydrated(true);

    function load() {
      if (cancelled || inFlight) return;
      inFlight = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      getStageInputs(projectId, stage, authHeaders())
        .then((res) => {
          if (cancelled) return;
          const raw = res?.inputs;
          const server: StageAnswers =
            raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
          serverKeyRef.current = answersKey(server);
          const localAhead = hasUnsaved(projectId, stage);
          if (hasContent(server) && !localAhead && !dirtyRef.current) {
            const restored = initialAnswers(fields, server);
            answersRef.current = restored;
            onChange(restored);
          } else if (localAhead || (localWritten && !hasContent(server))) {
            // Edits this browser never got acknowledged, or a draft from before
            // answers were stored server-side: keep it and send it up.
            dirtyRef.current = true;
          }
          setLoadState("loaded");
        })
        .catch(() => {
          if (cancelled) return;
          // Unreachable cloud: the local draft stays editable, edits wait on
          // this device, and the read is retried before anything is written.
          setLoadState("failed");
          retryTimer = setTimeout(load, LOAD_RETRY_MS[Math.min(attempt++, LOAD_RETRY_MS.length - 1)]);
        })
        .finally(() => {
          inFlight = false;
        });
    }
    retryLoadRef.current = load;
    load();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryLoadRef.current = null;
      // Leaving with a save still pending sends it rather than dropping it.
      if (timerRef.current) save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      // Defaults alone aren't a draft; caching them would make them look like one.
      if (answersKey(answers) === defaultsKey) {
        localStorage.removeItem(stageDraftKey(projectId, stage));
      } else {
        localStorage.setItem(stageDraftKey(projectId, stage), JSON.stringify(answers));
      }
    } catch {
      // A full or blocked localStorage costs the draft, not the generation.
    }
  }, [hydrated, answers, projectId, stage, defaultsKey]);

  useEffect(() => {
    if (!hydrated || loadStateRef.current === "loading" || !pending()) return;
    markUnsaved(projectId, stage, true);
    if (loadStateRef.current !== "loaded") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => save(), AUTOSAVE_DELAY_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, loadState, answers, projectId, stage]);

  function update(next: StageAnswers) {
    // Read-only until the server's answers are in: an edit made before then
    // would be saved over answers nobody has seen.
    if (loadStateRef.current === "loading") return;
    dirtyRef.current = true;
    onChange(next);
    if (loadStateRef.current === "failed") retryLoadRef.current?.();
  }

  function set(key: string, value: string) {
    update({ ...answers, [key]: value });
  }

  // Drafting fills blanks only. Overwriting an answer someone typed is the one
  // thing a "help me start" button must never do, and the author can always
  // clear a field and draft again to replace it deliberately.
  async function draftFromSources() {
    setDrafting(true);
    setDraftError(null);
    setDraftNote(null);
    try {
      const drafted = await prefillStage(
        projectId,
        stage,
        fields.map((f) => ({ key: f.key, label: f.label, hint: f.hint })),
        authHeaders(),
      );
      const next = { ...answers };
      let filled = 0;
      let kept = 0;
      for (const [key, value] of Object.entries(drafted.fields)) {
        if ((next[key] ?? "").trim()) kept += 1;
        else {
          next[key] = value;
          filled += 1;
        }
      }
      update(next);
      setDraftNote(
        filled === 0
          ? "Nothing new to add — the source material doesn't answer the blank fields."
          : `Drafted ${filled} field${filled === 1 ? "" : "s"} from ${drafted.sources.join(", ")}` +
              `${kept > 0 ? `, keeping ${kept} you'd already written` : ""}. Review before generating.`,
      );
    } catch (err) {
      const detail = (err as Error).message;
      setDraftError(
        (detail === "no_source_material" && prefill?.noSourceError) ||
          PREFILL_ERROR_TEXT[detail] ||
          detail,
      );
    } finally {
      setDrafting(false);
    }
  }

  const locked = disabled || loadState === "loading";

  return (
    <>
      {canPrefill && prefill && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={locked || drafting || Boolean(prefill.disabledReason)}
            onClick={draftFromSources}
            // Both stage forms carry this button, so a bare label is
            // ambiguous to a screen reader moving through the page.
            aria-label={prefill.ariaLabel}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
          >
            {drafting ? prefill.busyLabel : prefill.label}
          </button>
          <span className="text-xs text-slate-500">
            {prefill.disabledReason ?? prefill.description}
          </span>
        </div>
      )}
      {canPrefill && !prefill && prefillHint && (
        <p className="mb-3 text-xs text-slate-500">{prefillHint}</p>
      )}
      {draftNote && <p className="mb-3 text-xs text-slate-600">{draftNote}</p>}
      {draftError && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-xs text-amber-900">{draftError}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const id = `${stage}-${field.key}`;
        const wide = field.type === "textarea";
        return (
          <div key={field.key} className={wide ? "sm:col-span-2" : undefined}>
            <label htmlFor={id} className="block text-xs font-medium text-slate-700">
              {field.label}
              {field.required && <span className="ml-1 text-red-600">*</span>}
            </label>
            {field.hint && <p className="mb-1 text-xs text-slate-500">{field.hint}</p>}
            {field.type === "select" ? (
              <Select
                value={answers[field.key] ?? ""}
                disabled={locked}
                onValueChange={(v) => set(field.key, v)}
              >
                {/* `id` stays on the trigger so the <label htmlFor> above still
                    names it; the blank "Select…" option becomes a placeholder,
                    since Radix won't take an item with an empty value. */}
                <SelectTrigger id={id} className="mt-1 w-full">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : field.type === "textarea" ? (
              <textarea
                id={id}
                value={answers[field.key] ?? ""}
                disabled={locked}
                rows={field.rows ?? 3}
                placeholder={field.placeholder}
                onChange={(e) => set(field.key, e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 p-2 text-sm disabled:bg-slate-50"
              />
            ) : (
              <input
                id={id}
                type="text"
                value={answers[field.key] ?? ""}
                disabled={locked}
                placeholder={field.placeholder}
                onChange={(e) => set(field.key, e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 p-2 text-sm disabled:bg-slate-50"
              />
            )}
          </div>
        );
        })}
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 text-right text-xs text-slate-500">
        {loadState === "loading" && "Loading saved answers…"}
        {saveState === "saving" && "Saving…"}
        {saveState === "saved" && "Saved"}
        {saveState === "local" && "Saved on this device"}
        {saveState === "error" && (
          <span className="text-amber-800">
            Couldn&apos;t save —{" "}
            <button
              type="button"
              onClick={() => save()}
              className="underline hover:text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              retry
            </button>
          </span>
        )}
      </p>
    </>
  );
}
