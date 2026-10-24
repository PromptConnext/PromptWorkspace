// apps/web/src/components/project/StageDraftBanner.tsx
"use client";

import { useState } from "react";
import type { StageDraftOut } from "@/lib/types";

const BUTTON =
  "rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:border-slate-400 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

// A stage document the importer's local coding agent drafted through MCP,
// announced above the stage editor until a human accepts or rejects it. The
// draft's text itself is loaded into that editor, where the reviewer edits it;
// Accept writes the editor's text as the stage document (the cloud runs the
// same projection a save does); rejecting keeps the draft with the note, for
// the agent to redraft.
export function StageDraftBanner({
  draft,
  canAct,
  blockedBy,
  onAccept,
  onReject,
}: {
  draft: StageDraftOut;
  /** Mirrors the cloud's require_stage_access: a member may not review an
   *  admin-only stage's draft. */
  canAct: boolean;
  /** The predecessor this stage waits on; Accept stays disabled while set. */
  blockedBy?: string;
  onAccept: () => Promise<void>;
  onReject: (note: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  // A failed reject keeps the note; the caller says what went wrong.
  const confirmReject = () =>
    run(async () => {
      try {
        await onReject(note.trim());
      } catch {
        return;
      }
      setRejecting(false);
      setNote("");
    });

  // Only a pending draft can be accepted or rejected (a rejected one answers
  // 404 draft_not_found); the agent replaces it by submitting again.
  const showButtons = canAct && draft.status === "pending";
  const chip = draft.model ? `${draft.source} · ${draft.model}` : draft.source;

  return (
    <div className="mb-3 rounded border border-sky-200 bg-sky-50 p-3 text-sm text-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">Draft from your coding agent</p>
        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700">
          {chip}
        </span>
        {draft.stale && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
            Stale: written before the previous step changed
          </span>
        )}
      </div>
      {draft.status === "rejected" && (
        <p className="mt-2 text-xs text-slate-700">Rejected: {draft.rejection_note ?? ""}</p>
      )}
      {draft.last_error && (
        <p className="mt-2 text-xs text-amber-800">Could not apply: {draft.last_error}</p>
      )}
      {!canAct && draft.status === "pending" && <p className="mt-2 text-xs text-slate-600">Your Tech Lead reviews this draft.</p>}
      {showButtons && (
        <>
          {blockedBy && <p className="mt-2 text-xs text-slate-600">{blockedBy}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BUTTON}
              disabled={busy || Boolean(blockedBy)}
              onClick={() => run(onAccept)}
            >
              Accept
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={busy}
              onClick={() => setRejecting(true)}
            >
              Reject
            </button>
          </div>
          {rejecting && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="Rejection note"
                placeholder="Why this draft is rejected"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                className={BUTTON}
                disabled={busy || note.trim().length === 0}
                onClick={confirmReject}
              >
                Confirm
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
