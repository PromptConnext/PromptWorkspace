// apps/web/src/components/project/DeploymentTemplatePanel.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { updateDeploymentConfig } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { DeploymentTemplateOut, Project } from "@/lib/types";

// Maps apps/cloud/app/api/deployments.py's PATCH `detail` codes to sentences
// a Tech Lead can act on — same convention as PolicyScopePanel's
// describeError and CreateRepositoryPanel's DETAIL_MESSAGES.
function describeError(message: string): string {
  if (message === "project_frozen") {
    return "Locked after repository creation. Changing the template now means re-provisioning the repository.";
  }
  if (message === "unknown_deployment_template") {
    return "That template is no longer available — refresh the page.";
  }
  if (message === "admin_required") {
    return "Only a Tech Lead (workspace admin) can choose the deployment template.";
  }
  return message || "Failed to save the deployment template.";
}

export function DeploymentTemplatePanel({
  project,
  workspaceId,
  readOnly,
  onChange,
}: {
  project: Project;
  workspaceId: string;
  readOnly: boolean;
  onChange: () => void;
}) {
  const { authHeaders } = useAuth();
  const {
    data: templates,
    error: templatesError,
    loading: templatesLoading,
  } = useCloudGet<DeploymentTemplateOut[]>("/deployment-templates");

  const [selected, setSelected] = useState<string | null>(
    project.deployment_config?.template_id ?? null,
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  // Same guard as PolicyScopePanel: a parent refetch landing in
  // `project.deployment_config` must not overwrite a selection that is still
  // in flight.
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<string | null>(project.deployment_config?.template_id ?? null);

  useEffect(() => {
    if (dirtyRef.current) return;
    const templateId = project.deployment_config?.template_id ?? null;
    setSelected(templateId);
    lastSavedRef.current = templateId;
  }, [project.deployment_config]);

  // Single-select, so there is no debounce to manage: a click is the whole
  // edit, and saving immediately is what makes the absence of a Save button
  // honest.
  async function choose(templateId: string) {
    if (readOnly || templateId === lastSavedRef.current) return;
    dirtyRef.current = true;
    setSelected(templateId);
    setStatus("saving");
    setErrorDetail(null);
    try {
      await updateDeploymentConfig(project.id, templateId, authHeaders());
      lastSavedRef.current = templateId;
      dirtyRef.current = false;
      setStatus("saved");
      onChange();
    } catch (err) {
      dirtyRef.current = false;
      // Roll back to what the server actually holds, rather than leaving the
      // radio showing a choice that was refused.
      setSelected(lastSavedRef.current);
      setStatus("error");
      setErrorDetail(describeError((err as Error).message));
    }
  }

  const chosen = templates?.find((t) => t.id === selected) ?? null;

  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <h3 className="text-sm font-medium text-slate-900">Deployment template</h3>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        How this project gets built, deployed, and seen. The template you choose is committed into
        the repository — a starter app, a CI pipeline, and the credentials it needs — so a live
        preview exists from the first commit and business users can follow real progress.
      </p>

      {templatesLoading && <p className="text-xs text-slate-500">Loading templates…</p>}
      {templatesError && (
        <p className="text-xs text-red-600">Could not load deployment templates.</p>
      )}

      {templates && !readOnly && (
        <ul className="space-y-2">
          {templates.map((template) => (
            <li key={template.id} className="rounded border border-slate-200 p-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="deployment-template"
                  className="mt-1"
                  checked={selected === template.id}
                  onChange={() => choose(template.id)}
                  disabled={readOnly}
                />
                <span>
                  <span className="font-medium text-slate-900">{template.name}</span>
                  <span className="block text-xs text-slate-500">{template.description}</span>
                  <span className="mt-1 block text-xs text-slate-400">
                    {template.provider_label}
                    {template.provider_is_platform_owned
                      ? " · no account needed"
                      : " · needs a connected account"}
                  </span>
                </span>
              </label>

              <button
                type="button"
                className="mt-2 text-xs text-slate-500 underline hover:text-slate-700"
                onClick={() =>
                  setExpanded((prev) => ({ ...prev, [template.id]: !prev[template.id] }))
                }
              >
                {expanded[template.id] ? "Hide what it commits" : "See what it commits"}
              </button>
              {expanded[template.id] && (
                <div className="mt-2">
                  <p className="mb-1 text-xs text-slate-500">
                    {template.scaffold_paths.length} files, including:
                  </p>
                  <ul className="mb-2 list-inside list-disc text-xs text-slate-500">
                    {template.scaffold_paths.slice(0, 8).map((path) => (
                      <li key={path}>
                        <code>{path}</code>
                      </li>
                    ))}
                  </ul>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs">
                    {template.workflow_preview}
                  </pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly && (
        <p className="text-sm text-slate-600">
          {chosen ? (
            <>
              Deploying with <span className="font-medium">{chosen.name}</span>.
            </>
          ) : selected ? (
            <>
              Deploying with <span className="font-medium">{selected}</span>.
            </>
          ) : (
            "No deployment template was selected for this project."
          )}
        </p>
      )}

      {status === "saving" && <p className="mt-2 text-xs text-slate-500">Saving…</p>}
      {status === "saved" && <p className="mt-2 text-xs text-slate-500">Saved</p>}
      {status === "error" && errorDetail && (
        <p className="mt-2 text-xs text-red-600">{errorDetail}</p>
      )}

      {!readOnly && !selected && (
        <p className="mt-3 text-xs text-amber-700">
          Without a template this project gets a repository but no pipeline — nothing will deploy,
          and business users will have no live application to review.
        </p>
      )}

      {/* A warning, not a block. Choosing a template before its credential is
          connected is a legitimate order of operations; the hard failure
          belongs at repository creation, where it can be specific. */}
      {!readOnly && chosen && !chosen.provider_is_platform_owned && (
        <p className="mt-3 text-xs text-amber-700">
          {chosen.provider_label} must be connected in{" "}
          <Link href={`/w/${workspaceId}/settings`} className="underline">
            workspace settings
          </Link>{" "}
          before the repository can be created.
        </p>
      )}
    </section>
  );
}
