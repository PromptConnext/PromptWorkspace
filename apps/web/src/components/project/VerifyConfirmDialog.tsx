"use client";

import { useEffect, useId, useRef } from "react";
import { plainInlineCode } from "@/lib/inlineCode";
import { taskRefLabel } from "@/lib/taskOrder";
import type { Artifact, Task } from "@/lib/types";
import { InlineCodeText, isHttpUrl } from "./TaskCard";

/** `{repo}/commit/{sha}` for an http(s) repository URL, else null. */
export function commitUrl(repoUrl: string | null | undefined, sha: string): string | null {
  if (!repoUrl || !isHttpUrl(repoUrl)) return null;
  const base = repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return `${base}/commit/${sha}`;
}

/** Where an artifact points: its own http(s) URI, else the repository's commit page. */
export function artifactHref(artifact: Artifact, repoUrl: string | null | undefined) {
  if (isHttpUrl(artifact.uri)) return artifact.uri;
  return artifact.commit_sha ? commitUrl(repoUrl, artifact.commit_sha) : null;
}

const FOCUSABLE = "button:not([disabled]), a[href]";

/**
 * Verifying is the one move that says "this work is accepted", so it shows
 * what that rests on first: the acceptance criteria and the commits.
 */
export function VerifyConfirmDialog({
  task,
  artifacts,
  repoUrl,
  onConfirm,
  onCancel,
}: {
  task: Task;
  artifacts: Artifact[];
  repoUrl: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelHandler = useRef(onCancel);
  useEffect(() => {
    cancelHandler.current = onCancel;
  });

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    // Capture phase, so Escape closes this dialog and not the drawer behind it.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelHandler.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (returnTo && document.contains(returnTo)) returnTo.focus();
    };
  }, []);

  const label = taskRefLabel(task) ?? plainInlineCode(task.title);
  const criteria = task.acceptance_criteria;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/30 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          Mark {label} as verified?
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          <InlineCodeText text={task.title} />
        </p>

        <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Acceptance criteria
        </h3>
        {criteria.length > 0 ? (
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {criteria.map((c, i) => (
              <li key={i} className="break-words">
                {c.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-slate-400">No acceptance criteria</p>
        )}

        <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Artifacts
        </h3>
        {artifacts.length > 0 ? (
          <ul className="mt-1 space-y-1 text-sm">
            {artifacts.map((a) => {
              const href = artifactHref(a, repoUrl);
              const text = a.commit_sha ? (
                <span translate="no" className="font-mono">
                  {a.commit_sha.slice(0, 7)}
                </span>
              ) : (
                <span className="break-all">{a.uri}</span>
              );
              return (
                <li key={a.id}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      {text}
                    </a>
                  ) : (
                    <span className="text-slate-700">{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-slate-600">No commit is linked to this task yet.</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Mark verified
          </button>
        </div>
      </div>
    </div>
  );
}
