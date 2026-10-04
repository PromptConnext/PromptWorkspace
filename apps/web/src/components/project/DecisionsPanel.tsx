"use client";

import { useState } from "react";
import { resolveDecision } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useCloudGet } from "@/lib/hooks";
import type { Decision, DecisionsOut, WorkspaceMember } from "@/lib/types";
import { APPROVAL_LABEL } from "./ApprovalControl";
import { memberFullName } from "./MemberChip";

const HAT_LABEL: Record<Decision["routed_hat"], string> = {
  business_owner: "business owner",
  tech_steward: "tech steward",
};

const STATUS_LABEL: Record<Decision["status"], string> = {
  open: "Open",
  approved: "Approved",
  rejected: "Changes requested",
  withdrawn: "Withdrawn",
};

function DecisionRow({
  decision,
  members,
  onResolved,
}: {
  decision: Decision;
  members: WorkspaceMember[];
  /** Receives the listing as it stands after the resolve. */
  onResolved: (snapshot: DecisionsOut | null | undefined) => void;
}) {
  const { authHeaders } = useAuth();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string | null) => memberFullName(members.find((m) => m.user_id === id));

  async function resolve(outcome: "approved" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      const { snapshot } = await resolveDecision(
        decision.project_id,
        decision.id,
        outcome,
        reason.trim() || null,
        authHeaders(),
      );
      onResolved(snapshot);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not resolve");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-slate-900">{decision.title}</span>
        <span className="text-xs text-slate-500">{STATUS_LABEL[decision.status]}</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Requested by {name(decision.requested_by)} · {new Date(decision.created_at).toLocaleString()}
      </p>
      {decision.rationale && <p className="mt-2 text-sm text-slate-700">{decision.rationale}</p>}
      {decision.status === "open" && !decision.can_resolve && (
        <p className="mt-2 text-xs text-slate-500">Waiting on the {HAT_LABEL[decision.routed_hat]}.</p>
      )}
      {decision.status === "open" && decision.can_resolve && (
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs text-slate-600">
            Reason
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-slate-200 p-2 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => resolve("approved")}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy || reason.trim() === ""}
              onClick={() => resolve("rejected")}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-50"
            >
              Request changes
            </button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-rose-700">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** Plan 0029 Decisions tab: where the project's approvals stand and every
 * decision behind them, with the resolve form for decisions routed to me. */
export function DecisionsPanel({ projectId, workspaceId }: { projectId: string; workspaceId: string }) {
  const { data, error, refetch, mutate } = useCloudGet<DecisionsOut>(`/projects/${projectId}/decisions`);
  // Apply the resolve's snapshot; refetch when it carries none.
  const onResolved = (snapshot: DecisionsOut | null | undefined) =>
    snapshot ? mutate(snapshot) : refetch();
  const { data: members } = useCloudGet<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);

  if (error) return <p className="text-sm text-rose-700">{error}</p>;
  if (!data) return null;
  const visible = data.decisions.filter((d) => d.status !== "withdrawn");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {(["intent", "plan"] as const).map((key) => (
          <div key={key} className="rounded-lg border border-slate-200 bg-white p-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {key === "intent" ? "Intent" : "Delivery plan"}
            </h4>
            <p className="mt-1 text-sm font-medium text-slate-900">{APPROVAL_LABEL[data.states[key]]}</p>
          </div>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="text-sm text-slate-500">
          No decisions yet. Request approval from the Planner&apos;s Specify or Tasks step, or from the Delivery tab.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((d) => (
            <DecisionRow key={d.id} decision={d} members={members ?? []} onResolved={onResolved} />
          ))}
        </ul>
      )}
    </div>
  );
}
