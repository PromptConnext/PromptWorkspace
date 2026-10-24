// apps/web/src/components/project/PolicyScopePanel.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { PolicyScopeEditor } from "@/components/policy/PolicyScopeEditor";
import { updatePolicyScope, useWorkspaceScope as applyWorkspaceScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { PolicyScope, PolicyTemplateOut, Project } from "@/lib/types";

const EMPTY_SCOPE: PolicyScope = { selected: [], custom_text: "" };

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

  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const lastSavedRef = useRef<PolicyScope>(project.policy_scope ?? EMPTY_SCOPE);

  useEffect(() => {
    lastSavedRef.current = project.policy_scope ?? EMPTY_SCOPE;
  }, [project.policy_scope]);

  async function save(nextScope: PolicyScope) {
    if (scopesEqual(nextScope, lastSavedRef.current)) return;
    setStatus("saving");
    setErrorDetail(null);
    try {
      const updated = await updatePolicyScope(project.id, nextScope, authHeaders());
      lastSavedRef.current = updated.policy_scope ?? nextScope;
      setStatus("saved");
      onChange();
    } catch (err) {
      setStatus("error");
      setErrorDetail((err as Error).message);
    }
  }

  async function useWorkspace() {
    setStatus("saving");
    setErrorDetail(null);
    try {
      const updated = await applyWorkspaceScope(project.id, authHeaders());
      lastSavedRef.current = updated.policy_scope ?? EMPTY_SCOPE;
      setStatus("saved");
      onChange();
    } catch (err) {
      setStatus("error");
      setErrorDetail((err as Error).message);
    }
  }

  const inherited = project.policy_scope_source === "workspace";
  const frozen = project.lifecycle_status === "repo_created";

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">Policy scope</h3>
      <p className="mb-1 mt-1 text-xs text-slate-500">
        Choose the compliance and regulatory frames this project should be built against. The
        selected scope shapes the generated project rules and every stage after it.
      </p>
      {project.policy_scope_source && (
        <p className="mb-3 text-xs font-medium text-slate-700">
          {inherited ? "Inherited from the workspace" : "This project uses its own scope"}
        </p>
      )}
      {!inherited && project.policy_scope_source && !readOnly && !frozen && (
        <button
          type="button"
          onClick={() => void useWorkspace()}
          className="mb-3 rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
        >
          Use workspace scope
        </button>
      )}

      {templatesLoading && <p className="text-xs text-slate-500">Loading policy templates…</p>}
      {templatesError && (
        <p className="mb-3 text-xs text-amber-700">Couldn&apos;t load policy templates: {templatesError}</p>
      )}

      <PolicyScopeEditor
        scope={project.policy_scope}
        templates={templates}
        readOnly={readOnly}
        onSave={(scope) => void save(scope)}
        emptyHint="Select policy scope before generating the constitution so compliance principles are included."
      />

      {!readOnly && (
        <p className="mt-2 text-xs text-slate-500">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && errorDetail && (
            <span className="text-red-600">{describeError(errorDetail)}</span>
          )}
        </p>
      )}
    </div>
  );
}
