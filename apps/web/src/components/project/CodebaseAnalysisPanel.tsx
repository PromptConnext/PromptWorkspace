// apps/web/src/components/project/CodebaseAnalysisPanel.tsx
"use client";

import { useEffect, useState } from "react";
import { patchRepoAnalysis } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { AgentPlanningChecklist } from "./AgentPlanningChecklist";
import type { RepoAnalysisOut, RepoSkippedFile, StageDraftOut, StageKind } from "@/lib/types";

// The element the Plan and Tasks tabs' "Analyze the repository first" notice
// scrolls to after switching to the Foundation tab.
export const CODEBASE_ANALYSIS_ANCHOR = "codebase-analysis";

// apps/cloud/app/api/repo_analysis.py's refusals, all raised before the
// stream opens, plus the two model-side ones _resolve_model shares with stage
// generation. Per-component map, house convention — see
// CreateRepositoryPanel.tsx's DETAIL_MESSAGES.
export const ANALYSIS_ERROR_TEXT: Record<string, string> = {
  admin_required: "Only a workspace admin (the Tech Lead) can analyze the repository.",
  repo_analysis_not_found: "There is no baseline to save yet — your coding agent submits it with the start_planning flow.",
};

const STATUS_TEXT: Record<RepoAnalysisOut["status"], string> = {
  none: "Not analyzed yet.",
  snapshot_ready: "The repository has been read; the codebase baseline isn't written yet.",
  baseline_ready: "Analyzed — the plan and tasks are written against this baseline.",
  failed: "The last analysis didn't finish. The repository read was kept; ask your coding agent to try again.",
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
  drafts = [],
  stageDocsPresent = {},
}: {
  projectId: string;
  analysis: RepoAnalysisOut;
  /** Workspace admin — the cloud refuses both writes to anyone else. */
  canEdit: boolean;
  onChange: (next: RepoAnalysisOut) => void;
  /** Agent-written stage drafts awaiting review. */
  drafts?: StageDraftOut[];
  /** Stages that already have a saved document. */
  stageDocsPresent?: Partial<Record<StageKind, boolean>>;
}) {
  const { authHeaders } = useAuth();
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
        changes to its code rather than a new application. Your coding agent reads the repository
        and drafts the baseline and the planning documents; you review and accept them here.
      </p>

      <p className="text-sm text-slate-700">{STATUS_TEXT[analysis.status]}</p>
      {analysis.stale === true && (
        <p className="mt-1 text-xs text-amber-700">
          New commits landed on the default branch after this analysis. Ask your coding agent to
          redraft if they change what the plan should be written against.
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
          {skippedCount > 0 && skipped.length === 0 && (
            // A member's list arrives without the secret-shaped names, so it
            // can be empty while the count is not: nothing to expand.
            <p>
              {skippedCount} file{skippedCount === 1 ? "" : "s"} skipped
            </p>
          )}
          {skipped.length > 0 && (
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

      {analysis.required === true && (
        <AgentPlanningChecklist
          analysis={analysis}
          drafts={drafts}
          stageDocsPresent={stageDocsPresent}
        />
      )}

      {/* The baseline is an input to planning, so it reads like the stage
          documents it feeds — same editor — and an admin can correct it by
          hand. There is nothing to PATCH before a first analysis. */}
      {hasAnalysis && (
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
