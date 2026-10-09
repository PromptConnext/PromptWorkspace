"use client";

import { useEffect, useRef, useState } from "react";
import { requestDecision } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ApprovalState, DecisionKind } from "@/lib/types";
import { useDecisionsData } from "./DeliveryOverview";
import { RetryButton } from "./RetryButton";

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
 * (plan 0029 M2). Reads the project's shared delivery overview, so the
 * Planner, the Delivery tab and the Decisions tab show the same truth. */
export function ApprovalControl({
  projectId,
  kind,
  refreshKey,
}: {
  projectId: string;
  kind: DecisionKind;
  /** Anything that changes when the approved document does (e.g. its saved-at
   *  stamp). The states are fetched once, so without it a save leaves
   *  "Approved" showing beside a document the server now calls stale. */
  refreshKey?: string | number | null;
}) {
  const { authHeaders } = useAuth();
  const { data, error: loadError, refetch, retry, mutate } = useDecisionsData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A save of the approved document makes the approval stale on the server,
  // but the answer is a round trip away. Until it lands, show what the save
  // already means; any new response from the server replaces this guess.
  const [savedSinceLoad, setSavedSinceLoad] = useState(false);
  const serverState: ApprovalState | null = data
    ? data.states[kind === "intent_approval" ? "intent" : "plan"]
    : null;
  const serverStateRef = useRef(serverState);
  serverStateRef.current = serverState;

  useEffect(() => {
    setSavedSinceLoad(false);
  }, [data]);

  const lastKey = useRef(refreshKey);
  useEffect(() => {
    if (lastKey.current === refreshKey) return;
    lastKey.current = refreshKey;
    if (serverStateRef.current === "approved") setSavedSinceLoad(true);
    refetch();
  }, [refreshKey, refetch]);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      // The response carries the listing after the request; applying it
      // saves a refetch (a second set of cross-region database round trips).
      // No snapshot (the API could not read after its write, or predates
      // snapshots): refetch then.
      const { snapshot } = await requestDecision(projectId, kind, authHeaders());
      if (snapshot) mutate(snapshot);
      else refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    // Until the states load there is nothing true to show, and a request
    // button here could ask again over an approval the user can't see yet.
    return loadError ? (
      <div role="alert" className="flex items-center gap-2 text-xs text-rose-700">
        <span>{loadError}</span>
        <RetryButton onClick={retry} />
      </div>
    ) : (
      <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500">Loading…</span>
    );
  }

  const state: ApprovalState =
    savedSinceLoad && serverState === "approved" ? "stale" : (serverState as ApprovalState);
  const canRequest = state === "none" || state === "stale" || state === "changes_requested";

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
      {(error ?? loadError) && (
        <p role="alert" className="text-xs text-rose-700">
          {error ?? loadError}
        </p>
      )}
    </div>
  );
}
