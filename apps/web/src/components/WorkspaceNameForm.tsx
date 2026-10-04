"use client";

import { useEffect, useState } from "react";
import { renameWorkspace } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIsWorkspaceAdmin, useWorkspace, useWorkspaceName } from "@/lib/workspace";

// The server (PATCH /workspaces/{id}) accepts any string, including blank, so
// the only bounds on a workspace name are the ones enforced here.
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

  // The roster can land after first paint (or change after a save); follow it
  // so the input never keeps a stale name.
  useEffect(() => {
    setName(currentName);
  }, [currentName]);

  const trimmed = name.trim();
  const canSave = !busy && trimmed !== "" && trimmed !== currentName;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await renameWorkspace(workspaceId, trimmed, authHeaders());
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
