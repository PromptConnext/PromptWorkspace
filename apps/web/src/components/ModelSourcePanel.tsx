"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { EffectiveStageRouting, ModelSource, RoutingTable, StageKind } from "@/lib/types";

const STAGE_LABELS: Record<StageKind, string> = {
  constitution: "Constitution",
  specify: "Specify",
  plan: "Plan",
  tasks: "Tasks",
};

const ORIGIN_LABELS: Record<EffectiveStageRouting["origin"], string> = {
  project: "This project",
  workspace: "Workspace default",
  default: "Platform default",
};

// Shared by both the workspace-level and project-level settings pages —
// only the API path and PUT scope differ. `scope: "project"` writes to
// /projects/{id}/routing (wins over the workspace default); `"workspace"`
// writes to /workspaces/{id}/routing (the fallback every project without
// its own override inherits).
export function ModelSourcePanel({
  scope,
  id,
  isAdmin,
}: {
  scope: "workspace" | "project";
  id: string;
  isAdmin: boolean;
}) {
  const { authHeaders } = useAuth();
  const path = scope === "workspace" ? `/workspaces/${id}/routing` : `/projects/${id}/routing`;
  const { data, error, loading, refetch } = useCloudGet<RoutingTable>(path);
  const [pendingStage, setPendingStage] = useState<StageKind | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function updateStage(stage: StageKind, model_source: ModelSource) {
    setSaveError(null);
    setPendingStage(stage);
    try {
      await apiFetch(path, authHeaders(), {
        method: "PUT",
        body: JSON.stringify({ stage, model_source }),
      });
      refetch();
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setPendingStage(null);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-sm font-medium text-slate-900">Model source</h2>
      <p className="mb-4 text-sm text-slate-500">
        Which model generates each Spec Kit stage —{" "}
        <span className="font-medium">Managed</span> uses PromptConnext&apos;s free hosted
        Typhoon tier; <span className="font-medium">BYO key</span> uses{" "}
        {scope === "workspace" ? "this workspace's" : "the workspace's"} connected model.
      </p>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {data && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
          {data.routing.map((row) => (
            <li key={row.stage} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{STAGE_LABELS[row.stage]}</p>
                <p className="text-xs text-slate-500">{ORIGIN_LABELS[row.origin]}</p>
              </div>
              <select
                value={row.model_source}
                disabled={!isAdmin || pendingStage === row.stage}
                onChange={(e) => updateStage(row.stage, e.target.value as ModelSource)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:opacity-60"
              >
                <option value="managed">Managed</option>
                <option value="byo">BYO key</option>
              </select>
            </li>
          ))}
        </ul>
      )}

      {saveError && <p className="mt-3 text-sm text-red-600">{saveError}</p>}
      {!isAdmin && (
        <p className="mt-3 text-xs text-slate-400">Only a workspace admin can change this.</p>
      )}
    </section>
  );
}
