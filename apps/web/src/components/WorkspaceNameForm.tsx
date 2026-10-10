"use client";

import { useEffect, useState } from "react";
import { renameWorkspace } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIsWorkspaceAdmin, useWorkspace, useWorkspaceName } from "@/lib/workspace";

// Mirrors the server's WorkspaceName rule (apps/cloud/app/models/schemas.py):
// trimmed, 1-100 characters. Enforced here too so the user is stopped before a 422.
export const WORKSPACE_NAME_MAX_LENGTH = 100;

const DETAIL_MESSAGES: Record<string, string> = {
  admin_required: "Only a workspace admin can rename this workspace.",
};

export function WorkspaceNameForm({ workspaceId }: { workspaceId: string }) {
  const { authHeaders } = useAuth();
  const { refetch } = useWorkspace();
  const isAdmin = useIsWorkspaceAdmin(workspaceId);
  const currentName = useWorkspaceName(workspaceId);
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last name the server accepted. The roster refetch that updates
  // `currentName` lands a beat after the PATCH returns; until then this keeps
  // Save disabled (no double submit) and drives the "Saved" confirmation.
  const [savedName, setSavedName] = useState<string | null>(null);

  // The roster can land after first paint (or change after a save); follow it
  // so the input never keeps a stale name. A name that differs from the one
  // saved here came from elsewhere (another admin's rename), so the saved-name
  // guard no longer applies: without dropping it, renaming back to that name
  // would stay disabled.
  useEffect(() => {
    setName(currentName);
    setSavedName((saved) => (saved === currentName ? saved : null));
  }, [currentName]);

  const trimmed = name.trim();
  const canSave = !busy && trimmed !== "" && trimmed !== currentName && trimmed !== savedName;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await renameWorkspace(workspaceId, trimmed, authHeaders());
      setSavedName(trimmed);
      // The provider's roster is the single source of every displayed name
      // (switcher, crumbs, workspace page); refetching it updates them all.
      refetch();
    } catch (err) {
      const message = (err as Error).message;
      setError(DETAIL_MESSAGES[message] ?? message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Workspace name</h2>
      {isAdmin ? (
        <form onSubmit={save} className="flex flex-wrap items-start gap-2">
          <input
            aria-label="Workspace name"
            value={name}
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            onChange={(e) => setName(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {/* Always mounted and, while empty, only visually hidden (sr-only,
              not display:none): a live region that enters the accessibility
              tree together with its text is often not announced. */}
          <p role="status" className="w-full text-sm text-emerald-700 empty:sr-only">
            {savedName !== null && trimmed === savedName && !error ? "Saved" : ""}
          </p>
          {error && (
            <p role="alert" className="w-full text-sm text-red-600">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="break-words text-sm text-slate-700">{currentName}</p>
      )}
    </section>
  );
}
