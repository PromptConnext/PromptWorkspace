"use client";

import { useRef, useState } from "react";
import type { RepositoryDocsStatus, SyncDocsResult } from "@/lib/types";

// The cloud's refusals from GET docs-status and POST sync-docs
// (apps/cloud/app/api/repository_docs.py), as text a person can act on.
// `github_repo_not_in_token_scope` is deliberately not mapped here: a token
// without Pull requests write answers github_pr_permission_denied, so a scope
// message would send the admin to the wrong setting.
const ERROR_TEXT: Record<string, string> = {
  github_pr_permission_denied:
    "The workspace's GitHub token needs the Pull requests permission (Read and write).",
  github_branch_conflict: "Another sync is in progress or the branch changed. Try again.",
  github_write_forbidden:
    "The workspace's GitHub token can't write to this repository. It needs Contents and Pull " +
    "requests (Read and write).",
  github_branch_protected:
    "The repository refuses direct pushes to a new branch (a branch protection or ruleset). " +
    "Ask an owner to allow branches named pw/sync-docs-*.",
  github_sync_failed: "GitHub couldn't take the changes. Try again in a moment.",
  github_read_forbidden: "The workspace's GitHub token can't read this repository.",
  github_unreachable: "GitHub is unreachable. Try again.",
  github_not_configured: "GitHub is not connected for this workspace.",
  repository_not_created: "The repository hasn't been created yet.",
  repo_tree_too_large:
    "A directory in this repository is too large for GitHub to list, so PromptWorkspace can't " +
    "tell which documents are out of date. Nothing was written.",
  sync_not_supported_for_imported_repository:
    "Syncing documents isn't available for an imported repository yet.",
  repository_docs_current: "Repository documents are already up to date.",
};

const textFor = (code: string) => ERROR_TEXT[code] ?? code;

const BOX = "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900";
const LINK = "font-medium underline hover:text-amber-950";
const BUTTON =
  "mt-2 rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 " +
  "hover:border-amber-400 disabled:opacity-50";
const MERGE_HINT = ". Merge it on GitHub to bring the repository documents up to date.";

/** Tells whoever edits a planning document after the repository exists that the
 *  repository's seeded copy is behind, and (for an admin) opens or updates the
 *  pull request that catches it up. Renders nothing when no document is stale
 *  and no sync pull request is open.
 *
 *  What it shows follows the latest `status`. The result of a sync this banner
 *  ran is shown only until the status is next replaced (the Planner refetches
 *  after a sync), so a pull request that was merged or closed since can't leave
 *  a stale "opened" line behind. */
export function RepositoryDocsBanner({
  status,
  statusError,
  canSync,
  onSync,
}: {
  status: RepositoryDocsStatus | null;
  /** The code or message the status read failed with, when it did. */
  statusError?: string | null;
  canSync: boolean;
  onSync: () => Promise<SyncDocsResult>;
}) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{
    result: SyncDocsResult;
    updated: boolean;
    forStatus: RepositoryDocsStatus | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef<RepositoryDocsStatus | null>(null);

  // A malformed body (anything without a file list) counts as no status
  // rather than crashing the Planner around it.
  const valid = status && Array.isArray(status.files) ? status : null;
  latest.current = valid;

  if (!valid) {
    if (!statusError) return null;
    return (
      <p role="status" className="text-xs text-slate-500">
        Could not check repository documents: {textFor(statusError)}
      </p>
    );
  }

  // `in_pull_request` is waiting on a merge, not on a sync, so it is not stale.
  const stale = valid.files.filter((f) => f.state === "out_of_date" || f.state === "missing").length;
  const openPr = valid.open_sync_pr;
  const shown = done && done.forStatus === valid ? done : null;
  if (stale === 0 && !openPr && !shown) return null;

  async function handleSync() {
    setError(null);
    setDone(null);
    setPending(true);
    const updated = Boolean(valid?.open_sync_pr);
    try {
      const result = await onSync();
      // Keyed on the status in hand when the sync finished, not the one it
      // started with: a focus revalidation can land while the POST is in
      // flight. The Planner's refetch after the sync replaces it, which ends
      // the line in favour of the real state.
      setDone({ result, updated, forStatus: latest.current });
    } catch (err) {
      setError(textFor(err instanceof Error ? err.message : String(err)));
    } finally {
      setPending(false);
    }
  }

  const files = `${stale} ${stale === 1 ? "file" : "files"}`;

  return (
    <div role="status" className={BOX}>
      {shown ? (
        <p aria-live="polite">
          <a href={shown.result.pr_url} target="_blank" rel="noreferrer" className={LINK}>
            Pull request #{shown.result.pr_number} {shown.updated ? "updated" : "opened"}
          </a>
          {MERGE_HINT}
        </p>
      ) : openPr ? (
        <>
          <p>
            <a href={openPr.url} target="_blank" rel="noreferrer" className={LINK}>
              Pull request #{openPr.number} is open
            </a>
            {stale > 0 ? ` and ${files} ${stale === 1 ? "needs" : "need"} updating` : MERGE_HINT}
          </p>
          {stale > 0 && canSync && (
            <button type="button" onClick={handleSync} disabled={pending} className={BUTTON}>
              {pending ? "Updating…" : "Update the pull request"}
            </button>
          )}
        </>
      ) : (
        <>
          <p>Repository documents are out of date: {files}</p>
          {canSync && (
            <button type="button" onClick={handleSync} disabled={pending} className={BUTTON}>
              {pending ? "Opening…" : "Review and open a pull request"}
            </button>
          )}
        </>
      )}
      <p aria-live="polite" className={error ? "mt-2 text-red-700" : "sr-only"}>
        {error}
      </p>
    </div>
  );
}
