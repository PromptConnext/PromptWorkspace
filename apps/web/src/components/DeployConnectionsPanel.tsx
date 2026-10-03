"use client";

import { useCloudGet } from "@/lib/hooks";
import type { DeploymentTemplateOut } from "@/lib/types";
import { DeployConnectionForm } from "./DeployConnectionForm";

// Which providers a workspace can connect is derived from the templates that
// exist, rather than from a providers endpoint of its own: /deployment-templates
// already carries `provider`, `provider_label` and `provider_credential_owner`,
// and a provider no template uses is a provider nobody can select.
//
// Only `customer` providers appear. The other two have nothing to connect and
// the server refuses the attempt: `platform` is minted by PromptConnext per
// workspace, and `host` is the ephemeral token the git host hands each
// workflow run.

export function DeployConnectionsPanel({ workspaceId }: { workspaceId: string }) {
  const { data: templates, loading } = useCloudGet<DeploymentTemplateOut[]>(
    "/deployment-templates",
  );

  const providers = Array.from(
    new Map(
      (templates ?? [])
        .filter((t) => t.provider_credential_owner === "customer")
        .map((t) => [t.provider, t.provider_label] as const),
    ),
  );

  return (
    <section className="mb-10 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">Deployment providers</h2>
      <p className="mb-4 text-xs text-slate-500">
        A project&apos;s pipeline deploys using credentials PromptWorkspace writes into its
        repository when the repository is created. Connect the provider a project&apos;s
        deployment template uses before creating its repository — the token is verified here
        and stored encrypted, and is never shown again.
      </p>

      {loading && <p className="text-sm text-slate-500">Loading providers…</p>}

      {!loading && providers.length === 0 && (
        <p className="text-sm text-slate-500">
          No deployment template requires a provider credential. Nothing to connect.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {providers.map(([providerId, providerLabel]) => (
          <DeployConnectionForm
            key={providerId}
            workspaceId={workspaceId}
            providerId={providerId}
            providerLabel={providerLabel}
          />
        ))}
      </div>
    </section>
  );
}
