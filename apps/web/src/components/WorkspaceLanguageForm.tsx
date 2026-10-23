"use client";

import { useState } from "react";
import { setWorkspaceLanguage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Workspace } from "@/lib/types";
import { useIsWorkspaceAdmin, useWorkspace } from "@/lib/workspace";

type Language = Workspace["language"];

const LANGUAGE_LABELS: Record<Language, string> = { en: "English", th: "ไทย" };

const DETAIL_MESSAGES: Record<string, string> = {
  admin_required: "Only a workspace admin can change this setting.",
};

// Language used for the notifications the workspace sends (for example LINE
// messages). Saves on change: a single choice needs no separate Save step.
export function WorkspaceLanguageForm({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const { memberships, refetch } = useWorkspace();
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
  const current: Language = memberships.find((w) => w.id === workspaceId)?.language ?? "en";
  // Shown while the roster refetch is in flight, so the select never snaps back.
  const [pending, setPending] = useState<Language | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = pending ?? current;

  async function change(next: Language) {
    setPending(next);
    setBusy(true);
    setError(null);
    try {
      await setWorkspaceLanguage(workspaceId, next, authHeaders());
      refetch();
    } catch (err) {
      setPending(null);
      const message = (err as Error).message;
      setError(DETAIL_MESSAGES[message] ?? message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Language for notifications</h2>
      {isAdmin ? (
        <>
          <select
            aria-label="Language for notifications"
            value={value}
            disabled={busy}
            onChange={(e) => void change(e.target.value as Language)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none disabled:opacity-60"
          >
            <option value="en">{LANGUAGE_LABELS.en}</option>
            <option value="th">{LANGUAGE_LABELS.th}</option>
          </select>
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-slate-700">{LANGUAGE_LABELS[current]}</p>
      )}
    </section>
  );
}
