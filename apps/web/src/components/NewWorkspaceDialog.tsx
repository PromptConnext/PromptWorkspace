"use client";

import { useEffect, useState } from "react";
import { WORKSPACE_NAME_MAX_LENGTH } from "./WorkspaceNameForm";

// Follows NewProjectDialog's shape: a controlled, fixed-overlay dialog that
// owns its draft state and hands the caller the trimmed name. The caller owns
// the create call and the navigation after it.
export function NewWorkspaceDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setName("");
    setError(null);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const trimmed = name.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
      close();
    } catch (err) {
      setError((err as Error).message || "Failed to create workspace");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New workspace"
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <h2 className="mb-4 text-sm font-semibold text-slate-900">New workspace</h2>
        <label className="mb-2 block text-xs text-slate-600">
          Workspace name
          <input
            autoFocus
            value={name}
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            onChange={(e) => setName(e.target.value)}
            placeholder="Workspace name"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
        </label>
        {error && (
          <p role="alert" className="mb-2 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={close}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !trimmed}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
