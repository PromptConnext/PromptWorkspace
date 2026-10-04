"use client";

import { useState } from "react";
import { requestDecision } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { ApprovalState, DecisionKind, DecisionsOut } from "@/lib/types";

export const APPROVAL_LABEL: Record<ApprovalState, string> = {
  none: "Not requested",
  pending: "Waiting for approval",
  approved: "Approved",
  stale: "Changed since approval",
  changes_requested: "Changes requested",
};

const TONE: Record<ApprovalState, string> = {
  none: "bg-slate-100 text-slate-600",
  pending: "bg-amber-50 text-amber-800",
  approved: "bg-emerald-50 text-emerald-800",
  stale: "bg-amber-50 text-amber-800",
  changes_requested: "bg-rose-50 text-rose-800",
};

const BUTTON_LABEL: Record<DecisionKind, string> = {
  intent_approval: "Request intent approval",
  plan_approval: "Request plan approval",
};

/** The approval state of one stage document, and the way to ask for it
 * (plan 0029 M2). Self-contained so the Planner, the Delivery tab and the
 * Decisions tab show the same truth. */
export function ApprovalControl({ projectId, kind }: { projectId: string; kind: DecisionKind }) {
  const { authHeaders } = useAuth();
  const { data, refetch } = useCloudGet<DecisionsOut>(`/projects/${projectId}/decisions`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state: ApprovalState = data ? data.states[kind === "intent_approval" ? "intent" : "plan"] : "none";
  const canRequest = state === "none" || state === "stale" || state === "changes_requested";

  async function request() {
    setBusy(true);
    setError(null);
    try {
      await requestDecision(projectId, kind, authHeaders());
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[state]}`}>
        {APPROVAL_LABEL[state]}
      </span>
      {canRequest && (
        <button
          type="button"
          onClick={request}
          disabled={busy}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-50"
        >
          {BUTTON_LABEL[kind]}
        </button>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}
