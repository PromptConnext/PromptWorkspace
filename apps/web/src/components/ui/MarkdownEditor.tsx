// apps/web/src/components/ui/MarkdownEditor.tsx
"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";

type Mode = "raw" | "preview";

export function MarkdownEditor({
  value,
  onChange,
  onSave,
  saving = false,
  error = null,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving?: boolean;
  error?: string | null;
}) {
  const [mode, setMode] = useState<Mode>("raw");

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setMode("raw")}
            className={`rounded px-2 py-1 text-xs ${
              mode === "raw" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Raw
          </button>
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`rounded px-2 py-1 text-xs ${
              mode === "preview" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Preview
          </button>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave()}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs hover:border-slate-400 disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
      )}

      <div className="p-3">
        {mode === "raw" ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            className="w-full rounded border border-slate-300 p-2 font-mono text-xs text-slate-800"
          />
        ) : (
          <div className="prose prose-sm max-w-none text-slate-800">
            <ReactMarkdown>{value}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
