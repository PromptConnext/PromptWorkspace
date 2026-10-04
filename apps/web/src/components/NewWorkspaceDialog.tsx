"use client";

import { useEffect, useId, useRef, useState } from "react";
import { WORKSPACE_NAME_MAX_LENGTH } from "./WorkspaceNameForm";

// Follows NewProjectDialog's shape: a controlled, fixed-overlay dialog that
// owns its draft state and hands the caller the trimmed name. The caller owns
// the create call and the navigation after it.
export function NewWorkspaceDialog({
  open,
  onClose,
  onCreate,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  /** Focused again when the dialog closes (the control that opened it). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function close() {
    setName("");
    setError(null);
    onClose();
    // After a tick, once the dialog has unmounted, so the removal of the
    // focused input cannot drop focus back onto the page body.
    const target = returnFocusRef?.current;
    if (target) setTimeout(() => target.focus(), 0);
  }

  // Focus the input after a tick rather than relying on autoFocus: the
  // switcher that opened this dialog restores focus to its trigger as it
  // closes, and that must not win.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  // aria-modal is a promise to assistive tech, not a behavior: keep Escape and
  // Tab inside the dialog ourselves. Listening on the document, not the
  // dialog, keeps the trap working after a click on the backdrop has moved
  // focus to the page body. A create in flight can't be abandoned, so Escape
  // (and Cancel) wait for it to settle. The ref always holds this render's
  // handler, so the listener sees the current `busy` without re-subscribing.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!busy) close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  useEffect(() => {
    if (!open) return;
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
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
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-4 text-sm font-semibold text-slate-900">New workspace</h2>
        <label className="mb-2 block text-xs text-slate-600">
          Workspace name
          <input
            ref={inputRef}
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
            disabled={busy}
            className="text-sm text-slate-500 hover:text-slate-700 disabled:opacity-60"
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
