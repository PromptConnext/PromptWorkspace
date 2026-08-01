// apps/web/src/components/project/PolicyScopePanel.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { updatePolicyScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { PolicyScope, PolicyTemplateOut, Project } from "@/lib/types";

const EMPTY_SCOPE: PolicyScope = { selected: [], custom_text: "" };

// How long to wait after the last keystroke in the custom-text box before
// saving — matches the debounce feel of the stage editors without a save
// firing on every character.
const CUSTOM_TEXT_DEBOUNCE_MS = 800;

// Maps apps/cloud/app/api/policies.py's PATCH `detail` codes to sentences a
// business/tech-lead user can act on, same convention as
// CreateRepositoryPanel's DETAIL_MESSAGES.
function describeError(message: string): string {
  if (message === "project_frozen") {
    return "Locked after repository creation.";
  }
  if (message === "custom_text_too_long") {
    return "Custom policy text is too long — keep it under 20,000 characters.";
  }
  if (message === "unknown_policy_template") {
    return "One of the selected templates is no longer available — refresh the page.";
  }
  return message || "Failed to save policy scope.";
}

function scopesEqual(a: PolicyScope, b: PolicyScope): boolean {
  return (
    a.custom_text === b.custom_text &&
    a.selected.length === b.selected.length &&
    a.selected.every((id, i) => id === b.selected[i])
  );
}

export function PolicyScopePanel({
  project,
  readOnly,
  onChange,
}: {
  project: Project;
  readOnly: boolean;
  onChange: () => void;
}) {
  const { authHeaders } = useAuth();
  const { data: templates, error: templatesError, loading: templatesLoading } =
    useCloudGet<PolicyTemplateOut[]>("/policy-templates");

  const [selected, setSelected] = useState<string[]>(
    project.policy_scope?.selected ?? EMPTY_SCOPE.selected,
  );
  const [customText, setCustomText] = useState<string>(
    project.policy_scope?.custom_text ?? EMPTY_SCOPE.custom_text,
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Guards the sync-from-props effect below: while the user is mid-edit
  // (typed into the custom-text box but not yet saved), a parent refetch
  // landing in `project.policy_scope` must not stomp on what they typed.
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<PolicyScope>(project.policy_scope ?? EMPTY_SCOPE);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (dirtyRef.current) return;
    const scope = project.policy_scope ?? EMPTY_SCOPE;
    setSelected(scope.selected);
    setCustomText(scope.custom_text);
    lastSavedRef.current = scope;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.policy_scope]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  async function save(nextScope: PolicyScope) {
    if (scopesEqual(nextScope, lastSavedRef.current)) return;
    setStatus("saving");
    setErrorDetail(null);
    try {
      const updated = await updatePolicyScope(project.id, nextScope, authHeaders());
      lastSavedRef.current = updated.policy_scope ?? nextScope;
      dirtyRef.current = false;
      setStatus("saved");
      onChange();
    } catch (err) {
      dirtyRef.current = true;
      setStatus("error");
      setErrorDetail((err as Error).message);
    }
  }

  function toggle(id: string) {
    if (readOnly) return;
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    setSelected(next);
    void save({ selected: next, custom_text: customText });
  }

  function handleCustomTextChange(value: string) {
    if (readOnly) return;
    setCustomText(value);
    dirtyRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void save({ selected, custom_text: value });
    }, CUSTOM_TEXT_DEBOUNCE_MS);
  }

  function handleCustomTextBlur() {
    if (readOnly) return;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void save({ selected, custom_text: customText });
  }

  const selectedNames = (templates ?? [])
    .filter((t) => selected.includes(t.id))
    .map((t) => t.name);
  const isEmptyScope = selected.length === 0 && customText.trim().length === 0;

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">Policy scope</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        Choose the compliance and regulatory frames this project should be built against. The
        selected scope shapes the generated project rules and every stage after it.
      </p>

      {templatesLoading && <p className="text-xs text-slate-500">Loading policy templates…</p>}
      {templatesError && (
        <p className="mb-3 text-xs text-amber-700">Couldn&apos;t load policy templates: {templatesError}</p>
      )}

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

      {!readOnly && (
        <p className="text-xs text-slate-500">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && errorDetail && (
            <span className="text-red-600">{describeError(errorDetail)}</span>
          )}
        </p>
      )}

      {isEmptyScope && (
        <p className="mt-2 text-xs text-amber-700">
          Select policy scope before generating the constitution so compliance principles are
          included.
        </p>
      )}
    </div>
  );
}
