"use client";

import Link from "next/link";
import { claudeCodeCommand } from "@/components/ConnectSnippets";
import { CLOUD_API_URL } from "@/lib/config";
import type { RepoAnalysisOut, StageDraftOut, StageKind } from "@/lib/types";

export type ChecklistStatus = "Waiting" | "Pending review" | "Rejected" | "Accepted";

const STAGE_ROWS: { stage: StageKind; label: string }[] = [
  { stage: "constitution", label: "Rules" },
  { stage: "specify", label: "Specification" },
  { stage: "plan", label: "Plan" },
  { stage: "tasks", label: "Tasks" },
];

export function stageStatus(
  stage: StageKind,
  drafts: StageDraftOut[],
  stageDocsPresent: Partial<Record<StageKind, boolean>>,
): ChecklistStatus {
  const forStage = drafts.filter((d) => d.stage === stage);
  if (forStage.some((d) => d.status === "pending")) return "Pending review";
  const docPresent = stageDocsPresent[stage] === true;
  if (docPresent) return "Accepted";
  if (forStage.some((d) => d.status === "rejected")) return "Rejected";
  return "Waiting";
}

const STATUS_CLASS: Record<ChecklistStatus, string> = {
  Waiting: "bg-slate-100 text-slate-600",
  "Pending review": "bg-amber-100 text-amber-900",
  Rejected: "bg-red-100 text-red-800",
  Accepted: "bg-emerald-100 text-emerald-800",
};

// Plan 0027 follow-up: an imported project is planned by the importer's own
// coding agent through MCP tools; this lists what the agent still owes.
export function AgentPlanningChecklist({
  workspaceId,
  analysis,
  drafts,
  stageDocsPresent = {},
}: {
  /** The settings page holds the snippets for agents other than Claude Code. */
  workspaceId: string;
  analysis: RepoAnalysisOut;
  drafts: StageDraftOut[];
  stageDocsPresent?: Partial<Record<StageKind, boolean>>;
}) {
  const rows: { key: string; label: string; status: ChecklistStatus }[] = [
    {
      key: "baseline",
      label: "Baseline",
      status: analysis.status === "baseline_ready" ? "Accepted" : "Waiting",
    },
    ...STAGE_ROWS.map(({ stage, label }) => ({
      key: stage,
      label,
      status: stageStatus(stage, drafts, stageDocsPresent),
    })),
  ];

  return (
    <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm text-slate-700">
      <li>
        <p>Connect your coding agent to PromptWorkspace</p>
        <code className="mt-1 block break-all rounded bg-slate-50 px-2 py-1 text-xs">
          {claudeCodeCommand(CLOUD_API_URL)}
        </code>
        <Link
          href={`/w/${workspaceId}/settings`}
          className="mt-1 inline-block text-xs text-indigo-600 hover:underline"
        >
          Other agents
        </Link>
      </li>
      <li>
        <p>Open this repository in your coding agent and paste:</p>
        <code className="mt-1 block rounded bg-slate-50 px-2 py-1 text-xs">
          Call the PromptWorkspace start_planning tool for this repository and follow its
          instructions.
        </code>
      </li>
      <li>
        <p>Wait for drafts</p>
        <ul className="mt-1 space-y-1">
          {rows.map((row) => (
            <li key={row.key} className="flex items-center justify-between gap-2">
              <span>{row.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_CLASS[row.status]}`}>
                {row.status}
              </span>
            </li>
          ))}
        </ul>
      </li>
    </ol>
  );
}
