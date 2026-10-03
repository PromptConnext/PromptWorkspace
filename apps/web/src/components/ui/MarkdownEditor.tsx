// apps/web/src/components/ui/MarkdownEditor.tsx
"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

type Mode = "raw" | "preview";

/**
 * The mode an editor opens in when nobody has picked one: a document that
 * already says something is read first, an empty one (or one still arriving)
 * is something to write in.
 */
export function defaultEditorMode(value: string, streaming = false): Mode {
  return value.trim().length > 0 && !streaming ? "preview" : "raw";
}

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  saving = false,
  error = null,
  readOnly = false,
  streaming = false,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving?: boolean;
  error?: string | null;
  readOnly?: boolean;
  /** True while the document is being generated into — keeps the editor on
   *  Raw rather than flipping to a preview of half a document. */
  streaming?: boolean;
  /** Accessible name for the document, e.g. "Specification document". */
  label?: string;
}) {
  // Null until someone presses Raw or Preview: the default follows the content
  // (see defaultEditorMode), an explicit choice sticks.
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen ?? defaultEditorMode(value, streaming);

  const toggleClass = (on: boolean) =>
    `rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      on ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            aria-pressed={mode === "raw"}
            onClick={() => setChosen("raw")}
            className={toggleClass(mode === "raw")}
          >
            Raw
          </button>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            onClick={() => setChosen("preview")}
            className={toggleClass(mode === "preview")}
          >
            Preview
          </button>
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={saving}
            onClick={() => onSave()}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-xs hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="p-3">
        {mode === "raw" ? (
          <textarea
            value={value}
            onChange={(e) => {
              // Typing is choosing Raw: the first keystroke into an empty
              // document must not flip the editor to a preview of it.
              setChosen("raw");
              onChange(e.target.value);
            }}
            readOnly={readOnly}
            aria-label={label}
            rows={16}
            className="min-h-[24rem] w-full resize-y rounded border border-slate-300 p-2 font-mono text-xs text-slate-800"
          />
        ) : (
          <div
            role={label ? "region" : undefined}
            aria-label={label}
            className="prose prose-sm min-h-[24rem] max-w-none text-slate-800"
          >
            <ReactMarkdown>{value}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
