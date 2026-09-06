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
  // The provider verifies what was typed before it is stored (ADR 0025), so
  // these two are answers about the provider, not about this form.
  if (message === "deploy_project_not_found") {
    return "No project with that ID exists under the connected account. Create it with the provider first, then paste its ID here.";
  }
  if (message === "deploy_token_rejected") {
    return "The connected account's token was rejected. Reconnect the provider in workspace settings.";
  }
  // The Docker host template's three placement checks. Each guards a value
  // that reaches either a shell on the customer's host or a browser frame, so
  // each names the field it is about.
  if (message === "deploy_app_slug_invalid") {
    return "Use lowercase letters, numbers and hyphens for the application name — it becomes a directory and a Compose project on the host.";
  }
  if (message === "deploy_host_port_invalid") {
    return "The published port must be a number between 1 and 65535, and unused by other projects on that host.";
  }
  if (message === "deploy_public_url_must_be_https") {
    return "The preview URL must start with https://. The Preview tab is an HTTPS page, and a browser will not show an http:// application inside it.";
  }
  if (message === "deployment_provider_unreachable") {
    return "Could not reach the provider just now. Try saving again in a moment.";
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
  // The provider-side project this project deploys to (ADR 0025). Unlike the
  // template radio, this is typed rather than clicked, and the server verifies
  // it against the provider — so it saves on an explicit action, not on every
  // keystroke.
  const [values, setValues] = useState<Record<string, string>>(
    project.deployment_config?.provider_values ?? {},
  );

  // Same guard as PolicyScopePanel: a parent refetch landing in
  // `project.deployment_config` must not overwrite a selection that is still
  // in flight.
  const dirtyRef = useRef(false);
  const lastSavedRef = useRef<string | null>(project.deployment_config?.template_id ?? null);

  useEffect(() => {
    if (dirtyRef.current) return;
    const templateId = project.deployment_config?.template_id ?? null;
    setSelected(templateId);
    setValues(project.deployment_config?.provider_values ?? {});
    lastSavedRef.current = templateId;
  }, [project.deployment_config]);

  async function save(templateId: string, providerValues: Record<string, string>) {
    dirtyRef.current = true;
    setStatus("saving");
    setErrorDetail(null);
    try {
      await updateDeploymentConfig(project.id, templateId, providerValues, authHeaders());
      lastSavedRef.current = templateId;
      dirtyRef.current = false;
      setStatus("saved");
      onChange();
    } catch (err) {
      dirtyRef.current = false;
      // Roll back to what the server actually holds, rather than leaving the
      // form showing a choice that was refused.
      setSelected(lastSavedRef.current);
      setValues(project.deployment_config?.provider_values ?? {});
      setStatus("error");
      setErrorDetail(describeError((err as Error).message));
    }
  }

  // Single-select, so there is no debounce to manage: a click is the whole
  // edit. Switching template clears the provider values with it — they name a
  // resource belonging to the template's provider, so carrying them across
  // would keep a Vercel project id on a Docker host deployment.
  async function choose(templateId: string) {
    if (readOnly || templateId === lastSavedRef.current) return;
    setSelected(templateId);
    setValues({});
    await save(templateId, {});
  }

  const chosen = templates?.find((t) => t.id === selected) ?? null;
  const projectFields = chosen?.provider_project_fields ?? [];
  const savedValues = project.deployment_config?.provider_values ?? {};
  const valuesDirty = projectFields.some(
    (f) => (values[f.name] ?? "").trim() !== (savedValues[f.name] ?? ""),
  );
  const valuesComplete = projectFields.every((f) => (values[f.name] ?? "").trim());

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

      {/* ADR 0025: the provider-side project a build goes to belongs here, not
          in workspace settings. One Vercel project holds one production
          deployment, so a workspace-level id made every project in a workspace
          deploy over the top of the last one. */}
      {!readOnly && projectFields.length > 0 && (
        <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs text-slate-600">
            This project needs its own place on {chosen?.provider_label} — a workspace has many
            projects, and two of them sharing one would deploy over the top of each other. Set it
            up with {chosen?.provider_label} once, then name it here.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            {projectFields.map((field) => (
              <label
                key={field.name}
                className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs"
              >
                <span className="text-slate-500">{field.label}</span>
                <input
                  type={field.secret ? "password" : "text"}
                  value={values[field.name] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                  autoComplete="off"
                  className="rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
                />
              </label>
            ))}
            <button
              type="button"
              disabled={!valuesDirty || !valuesComplete || status === "saving"}
              onClick={() =>
                save(
                  selected as string,
                  Object.fromEntries(
                    projectFields.map((f) => [f.name, (values[f.name] ?? "").trim()]),
                  ),
                )
              }
              className="rounded bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
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
          The workspace&apos;s {chosen.provider_label} account must be connected in{" "}
          <Link href={`/w/${workspaceId}/settings`} className="underline">
            workspace settings
          </Link>
          {projectFields.length > 0 && !valuesComplete
            ? ", and this project needs its own project named above,"
            : ""}{" "}
          before the repository can be created.
        </p>
      )}
    </section>
  );
}
