// apps/web/src/components/project/StageInputForm.tsx
"use client";

import { useEffect, useState } from "react";
import { prefillStage } from "@/lib/api";
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

// Answers are the only part of a stage the server never stores — the endpoint
// keeps the generated document, not the prompt that produced it. Persisting
// them locally means reopening the project shows what was asked for, so a
// regeneration is an edit rather than a retype.
function loadDraft(projectId: string, stage: StageKind): StageAnswers {
  try {
    const raw = localStorage.getItem(stageDraftKey(projectId, stage));
    return raw ? (JSON.parse(raw) as StageAnswers) : {};
  } catch {
    return {};
  }
}

export function StageInputForm({
  projectId,
  stage,
  fields,
  answers,
  onChange,
  disabled = false,
  canPrefill = true,
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
}) {
  const { authHeaders } = useAuth();
  const [hydrated, setHydrated] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState<string | null>(null);

  useEffect(() => {
    onChange(initialAnswers(fields, loadDraft(projectId, stage)));
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(stageDraftKey(projectId, stage), JSON.stringify(answers));
    } catch {
      // A full or blocked localStorage costs the draft, not the generation.
    }
  }, [hydrated, answers, projectId, stage]);

  function set(key: string, value: string) {
    onChange({ ...answers, [key]: value });
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
      onChange(next);
      setDraftNote(
        filled === 0
          ? "Nothing new to add — the source material doesn't answer the blank fields."
          : `Drafted ${filled} field${filled === 1 ? "" : "s"} from ${drafted.sources.join(", ")}` +
              `${kept > 0 ? `, keeping ${kept} you'd already written` : ""}. Review before generating.`,
      );
    } catch (err) {
      const detail = (err as Error).message;
      setDraftError(PREFILL_ERROR_TEXT[detail] ?? detail);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <>
      {canPrefill && (
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || drafting}
          onClick={draftFromSources}
          // Both stage forms carry this button, so a bare "Draft from PRD" is
          // ambiguous to a screen reader moving through the page.
          aria-label={`Draft the ${stage} fields from the PRD`}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:border-slate-300 disabled:opacity-60"
        >
          {drafting ? "Reading the PRD…" : "Draft from PRD"}
        </button>
        <span className="text-xs text-slate-500">
          Fills the blank fields from the uploaded document — yours to edit.
        </span>
      </div>
      )}
      {draftNote &&<p className="mb-3 text-xs text-slate-600">{draftNote}</p>}
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
                disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
                placeholder={field.placeholder}
                onChange={(e) => set(field.key, e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 p-2 text-sm disabled:bg-slate-50"
              />
            )}
          </div>
        );
        })}
      </div>
    </>
  );
}
