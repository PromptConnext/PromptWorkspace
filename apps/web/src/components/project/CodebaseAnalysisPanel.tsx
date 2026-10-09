// apps/web/src/components/project/CodebaseAnalysisPanel.tsx
"use client";

import { useEffect, useState } from "react";
import { patchRepoAnalysis } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { useRepoAnalysis } from "./useRepoAnalysis";
import type { RepoAnalysisOut, RepoSkippedFile } from "@/lib/types";

// The element the Plan and Tasks tabs' "Analyze the repository first" notice
// scrolls to after switching to the Foundation tab.
export const CODEBASE_ANALYSIS_ANCHOR = "codebase-analysis";

// apps/cloud/app/api/repo_analysis.py's refusals, all raised before the
// stream opens, plus the two model-side ones _resolve_model shares with stage
// generation. Per-component map, house convention — see
// CreateRepositoryPanel.tsx's DETAIL_MESSAGES.
export const ANALYSIS_ERROR_TEXT: Record<string, string> = {
  admin_required: "Only a workspace admin (the Tech Lead) can analyze the repository.",
  repo_not_imported: "This project wasn't imported from a repository, so there is nothing to analyze.",
  repo_already_created:
    "The repository has already been created for this project — the analysis only matters before that.",
  github_not_configured:
    "No GitHub connection for this workspace. A workspace admin needs to connect one in workspace settings.",
  repo_url_unrecognized: "The imported repository's address isn't a GitHub repository PromptWorkspace recognises.",
  repo_owner_out_of_scope:
    "The imported repository isn't under the workspace's connected GitHub account any more — the " +
    "connection may have been changed since the import.",
  github_repo_not_in_token_scope:
    "The workspace's GitHub token can't read this repository. A workspace admin needs to add it to " +
    "the token's repository access and reissue it.",
  imported_repo_not_found:
    "The imported repository can't be found on GitHub — it may have been renamed, moved or deleted.",
  github_unreachable: "GitHub couldn't be reached. Try again in a moment.",
  model_connection_not_configured:
    "No model is configured for this workspace, so the analysis can't be written.",
  managed_tier_rate_limited: "The shared model is busy right now — try again in a moment.",
  daily_token_budget_exceeded:
    "This workspace hit its daily generation budget. Try again tomorrow, or write the baseline " +
    "below by hand — a saved baseline unlocks planning just the same.",
  repo_analysis_not_found: "Analyze the repository first — there is no baseline to save yet.",
};

const STATUS_TEXT: Record<RepoAnalysisOut["status"], string> = {
  none: "Not analyzed yet.",
  snapshot_ready: "The repository has been read; the codebase baseline isn't written yet.",
  baseline_ready: "Analyzed — the plan and tasks are written against this baseline.",
  failed: "The last analysis didn't finish. The repository read was kept; analyze again.",
};

const SKIP_REASON_TEXT: Record<RepoSkippedFile["reason"], string> = {
  vendored: "vendored or build directory",
  binary: "binary file",
  secret: "credential-shaped file, never read",
};

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700">
      {children}
    </span>
  );
}

// Plan 0027 M6. An imported repository is planned against its existing code,
// so the Plan and Tasks stages wait on this: a deterministic read of the
// repository plus one model-written "codebase baseline". Rendered by the
// Planner only while `analysis.required` — an imported project before
// `repo_created` — and the analysis state itself is owned there, because the
// Plan and Tasks tabs read it too.
export function CodebaseAnalysisPanel({
  projectId,
  analysis,
  canEdit,
  onChange,
}: {
  projectId: string;
  analysis: RepoAnalysisOut;
  /** Workspace admin — the cloud refuses both writes to anyone else. */
  canEdit: boolean;
  onChange: (next: RepoAnalysisOut) => void;
}) {
  const { authHeaders } = useAuth();
  const { status, streamedText, truncated, error, analyze } = useRepoAnalysis(projectId, onChange);
  const [draft, setDraft] = useState(analysis.baseline);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A finished stream or a refetch replaces the baseline; keep the editor on
  // the stored text rather than on whatever was typed over an older one.
  useEffect(() => {
    setDraft(analysis.baseline);
  }, [analysis.baseline]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      onChange(await patchRepoAnalysis(projectId, draft, authHeaders()));
    } catch (err) {
      const code = (err as Error).message;
      setSaveError(ANALYSIS_ERROR_TEXT[code] ?? code);
    } finally {
      setSaving(false);
    }
  }

  const snapshot = analysis.snapshot;
  const skipped = snapshot?.skipped ?? [];
  const skippedCount = snapshot?.skipped_count ?? 0;
  const analyzing = status === "analyzing";
  const hasAnalysis = analysis.status !== "none";

  return (
    <div id={CODEBASE_ANALYSIS_ANCHOR} className="rounded-lg border border-slate-200 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-slate-900">Codebase analysis</h3>
        {analysis.stale === true && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
            Repository changed since this analysis
          </span>
        )}
      </div>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        This project was imported from an existing repository, so the plan and tasks describe
        changes to its code rather than a new application. PromptWorkspace reads the repository and
        writes a baseline of what is already there; the Plan and Tasks steps wait until it exists.
      </p>

      <p className="text-sm text-slate-700">{STATUS_TEXT[analysis.status]}</p>
      {analysis.stale === true && (
        <p className="mt-1 text-xs text-amber-700">
          New commits landed on the default branch after this analysis. Re-analyze if they change
          what the plan should be written against.
        </p>
      )}

      {snapshot && (
        <div className="mt-3 space-y-2 rounded bg-slate-50 p-3 text-xs text-slate-600">
          <p>
            Commit <code>{snapshot.commit_sha.slice(0, 7)}</code> on{" "}
            <strong>{snapshot.default_branch}</strong> · {snapshot.file_count}
            {skippedCount > 0 && ` of ${snapshot.file_count + skippedCount}`} file
            {snapshot.file_count + skippedCount === 1 ? "" : "s"} read
          </p>
          {skippedCount > 0 && (
            <details>
              <summary className="cursor-pointer text-slate-700">
                {skippedCount} file{skippedCount === 1 ? "" : "s"} skipped
              </summary>
              <ul className="mt-2 max-h-64 space-y-0.5 overflow-auto">
                {skipped.map((entry) => (
                  <li key={entry.path}>
                    <code>{entry.path}</code>{" "}
                    <span className="text-slate-500">— {SKIP_REASON_TEXT[entry.reason]}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {snapshot.tree_truncated && (
            <p className="text-amber-700">
              GitHub listed only part of this repository — it is too large to list in one request —
              so the analysis covers the files it returned.
            </p>
          )}
          {(snapshot.stack.runtime ||
            snapshot.stack.languages.length > 0 ||
            snapshot.stack.manifests.length > 0) && (
            <div className="flex flex-wrap gap-1" aria-label="Detected stack">
              {snapshot.stack.runtime && <Chip>{snapshot.stack.runtime}</Chip>}
              {snapshot.stack.languages
                .filter((lang) => lang !== snapshot.stack.runtime)
                .map((lang) => (
                  <Chip key={`lang-${lang}`}>{lang}</Chip>
                ))}
              {snapshot.stack.manifests.map((manifest) => (
                <Chip key={`manifest-${manifest}`}>{manifest}</Chip>
              ))}
            </div>
          )}
          {snapshot.tree_summary && (
            <details>
              <summary className="cursor-pointer text-slate-700">Directory summary</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-slate-600">
                {snapshot.tree_summary}
              </pre>
            </details>
          )}
        </div>
      )}

      {canEdit ? (
        <div className="mt-3">
          <button
            type="button"
            disabled={analyzing}
            onClick={analyze}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:border-slate-300 disabled:opacity-60"
          >
            {analyzing ? "Analyzing…" : hasAnalysis ? "Re-analyze" : "Analyze repository"}
          </button>
          {/* Said before the click, not after: the baseline is charged to the
              daily budget and a re-analysis replaces a hand-edited one. */}
          <p className="mt-1 text-xs text-slate-500">
            {hasAnalysis
              ? "Re-analyzing reads the repository again and replaces the baseline below, edits included. It counts against the workspace's daily generation budget."
              : "Counts against the workspace's daily generation budget."}
          </p>
        </div>
      ) : (
        !hasAnalysis && (
          <p className="mt-3 rounded bg-slate-50 p-3 text-xs text-slate-600">
            Your Tech Lead analyzes the repository. You can read the result here once they do.
          </p>
        )
      )}

      {analyzing && streamedText && (
        <pre className="mt-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
          {streamedText}
        </pre>
      )}
      {status === "error" && error && (
        <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">
          <p>{ANALYSIS_ERROR_TEXT[error.error] ?? error.error}</p>
          {error.retryable && (
            <button
              type="button"
              onClick={analyze}
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs"
            >
              Retry
            </button>
          )}
        </div>
      )}
      {status === "done" && truncated && (
        <div className="mt-3 rounded bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">This baseline is incomplete</p>
          <p className="mt-1">
            The model reached its output limit before finishing. The partial baseline below was
            saved and unlocks planning — analyze again, or fill in the rest by hand.
          </p>
        </div>
      )}

      {/* The baseline is an input to planning, so it reads like the stage
          documents it feeds — same editor — and an admin can correct it by
          hand. There is nothing to PATCH before a first analysis. */}
      {hasAnalysis && !analyzing && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-slate-700">Codebase baseline</p>
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSave={save}
            saving={saving}
            error={saveError}
            readOnly={!canEdit}
          />
          {analysis.updated_at && (
            <p className="mt-1 text-xs text-slate-500">
              Last updated {new Date(analysis.updated_at).toLocaleString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
