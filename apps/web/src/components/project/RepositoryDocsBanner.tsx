"use client";

import { useState } from "react";
import type { RepositoryDocsStatus, SyncDocsResult } from "@/lib/types";

// The cloud's refusals from POST /projects/{id}/repository/sync-docs
// (apps/cloud/app/api/repository_docs.py), as text a person can act on.
// `github_repo_not_in_token_scope` is deliberately not mapped here: a token
// without Pull requests write answers github_pr_permission_denied, so a scope
// message would send the admin to the wrong setting.
const SYNC_ERROR_TEXT: Record<string, string> = {
  github_pr_permission_denied:
    "The workspace's GitHub token needs the Pull requests permission (Read and write).",
  github_branch_conflict: "The default branch changed while syncing. Try again.",
  github_sync_failed: "GitHub couldn't take the changes. Try again in a moment.",
  repo_tree_too_large:
    "A directory in this repository is too large for GitHub to list, so PromptWorkspace can't " +
    "tell which documents are out of date. Nothing was written.",
  sync_not_supported_for_imported_repository:
    "Syncing documents isn't available for an imported repository yet.",
  repository_docs_current: "The repository documents are already up to date.",
};

const BOX = "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900";
const LINK = "font-medium underline hover:text-amber-950";
const BUTTON =
  "rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 " +
  "hover:border-amber-400 disabled:opacity-50";

/** Tells whoever edits a planning document after the repository exists that the
 *  repository's seeded copy is behind, and (for an admin) opens the pull request
 *  that catches it up. Renders nothing when every document is current and no sync
 *  pull request is open. */
export function RepositoryDocsBanner({
  status,
  canSync,
  onSync,
}: {
  status: RepositoryDocsStatus | null;
  canSync: boolean;
  onSync: () => Promise<SyncDocsResult>;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SyncDocsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A malformed body (anything without a file list) is treated as no status
  // rather than crashing the Planner around it.
  if (!status || !Array.isArray(status.files)) return null;

  const stale = status.files.filter((f) => f.state !== "current").length;
  const openPr = status.open_sync_pr;
  if (stale === 0 && !openPr && !result) return null;

  async function handleSync() {
    setError(null);
    setPending(true);
    try {
      setResult(await onSync());
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(SYNC_ERROR_TEXT[code] ?? code);
    } finally {
      setPending(false);
    }
  }

  return (
    <div role="status" className={BOX}>
      {result ? (
        <p aria-live="polite">
          <a href={result.pr_url} target="_blank" rel="noreferrer" className={LINK}>
            Pull request #{result.pr_number} opened
          </a>
          . Merge it on GitHub to bring the repository documents up to date.
        </p>
      ) : openPr ? (
        <p>
          <a href={openPr.url} target="_blank" rel="noreferrer" className={LINK}>
            Pull request #{openPr.number} is open
          </a>
          . Merge it on GitHub to bring the repository documents up to date.
        </p>
      ) : (
        <>
          <p>
            Repository documents are out of date: {stale} {stale === 1 ? "file" : "files"}
          </p>
          {canSync && (
            <button type="button" onClick={handleSync} disabled={pending} className={`mt-2 ${BUTTON}`}>
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
