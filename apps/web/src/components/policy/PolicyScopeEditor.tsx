"use client";

import { useEffect, useRef, useState } from "react";
import type { PolicyScope, PolicyTemplateOut } from "@/lib/types";

// How long to wait after the last keystroke in the custom-text box before
// committing — matches the debounce feel of the stage editors.
const CUSTOM_TEXT_DEBOUNCE_MS = 800;

const EMPTY: PolicyScope = { selected: [], custom_text: "" };

// The template checklist plus custom text, shared by a project's policy panel
// and the workspace governance page. `onSave` fires on a toggle, on blur and
// after the typing debounce; `onEdit` fires on every change.
export function PolicyScopeEditor({
  scope,
  templates,
  readOnly,
  onSave,
  onEdit,
  emptyHint,
}: {
  scope: PolicyScope | null | undefined;
  templates: PolicyTemplateOut[] | null;
  readOnly: boolean;
  // Resolve false when the save failed, so unsaved text survives a prop refetch.
  onSave: (scope: PolicyScope) => void | Promise<boolean>;
  onEdit?: (scope: PolicyScope) => void;
  emptyHint?: string;
}) {
  const source = scope ?? EMPTY;
  const [selected, setSelected] = useState<string[]>(source.selected);
  const [customText, setCustomText] = useState<string>(source.custom_text);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // While the user is mid-edit in the text box, a refetch landing new props
  // must not stomp on what they typed.
  const dirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedKey = source.selected.join("\n");
  useEffect(() => {
    if (dirtyRef.current) return;
    setSelected(source.selected);
    setCustomText(source.custom_text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, source.custom_text]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function commit(next: PolicyScope) {
    dirtyRef.current = false;
    const result = onSave(next);
    if (result instanceof Promise) {
      void result.then((ok) => {
        if (!ok) dirtyRef.current = true;
      });
    }
  }

  function toggle(id: string) {
    if (readOnly) return;
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    setSelected(next);
    const nextScope = { selected: next, custom_text: customText };
    onEdit?.(nextScope);
    commit(nextScope);
  }

  function handleCustomTextChange(value: string) {
    if (readOnly) return;
    setCustomText(value);
    dirtyRef.current = true;
    onEdit?.({ selected, custom_text: value });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commit({ selected, custom_text: value }), CUSTOM_TEXT_DEBOUNCE_MS);
  }

  function handleCustomTextBlur() {
    if (readOnly) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    commit({ selected, custom_text: customText });
  }

  const selectedNames = (templates ?? [])
    .filter((t) => selected.includes(t.id))
    .map((t) => t.name);
  const isEmptyScope = selected.length === 0 && customText.trim().length === 0;

  return (
    <div>
      {templates && templates.length > 0 && (
        <ul className="mb-3 space-y-2">
          {templates.map((template) => (
            <li key={template.id} className="rounded border border-slate-200 p-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected.includes(template.id)}
                  onChange={() => toggle(template.id)}
                  disabled={readOnly}
                />
                <span>
                  <span className="font-medium text-slate-900">{template.name}</span>
                  <span className="block text-xs text-slate-500">{template.description}</span>
                </span>
              </label>
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [template.id]: !prev[template.id] }))
                }
                className="mt-1 text-xs text-slate-500 underline hover:text-slate-700"
              >
                {expanded[template.id] ? "Hide full text" : "View full text"}
              </button>
              {expanded[template.id] && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">
                  {template.body}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly && (
        <p className="mb-3 text-xs text-slate-600">
          {selectedNames.length > 0
            ? `Selected: ${selectedNames.join(", ")}`
            : "No policy templates selected."}
        </p>
      )}

      <label className="mb-2 block text-xs text-slate-600">
        Custom policy text
        <textarea
          value={customText}
          onChange={(e) => handleCustomTextChange(e.target.value)}
          onBlur={handleCustomTextBlur}
          disabled={readOnly}
          rows={4}
          placeholder="Add any project-specific policy language not covered above."
          className="mt-1 w-full rounded border border-slate-300 p-2 text-sm disabled:bg-slate-50 disabled:text-slate-500"
        />
      </label>

      {readOnly && customText.trim().length > 0 && (
        <p className="mb-2 whitespace-pre-wrap text-xs text-slate-600">{customText}</p>
      )}

      {isEmptyScope && emptyHint && <p className="mt-2 text-xs text-amber-700">{emptyHint}</p>}
    </div>
  );
}
