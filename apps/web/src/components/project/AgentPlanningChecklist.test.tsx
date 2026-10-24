import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPlanningChecklist } from "./AgentPlanningChecklist";
import type { RepoAnalysisOut, StageDraftOut, StageKind } from "@/lib/types";

const base: RepoAnalysisOut = {
  project_id: "p1",
  status: "none",
  required: true,
  commit_sha: null,
  snapshot: null,
  baseline: "",
  updated_at: null,
  stale: false,
  source: "agent",
  model: null,
};

function draft(stage: StageKind, status: StageDraftOut["status"]): StageDraftOut {
  return {
    id: `d-${stage}`,
    project_id: "p1",
    stage,
    markdown: "# Draft",
    source: "agent",
    model: null,
    status,
    stale: false,
    rejection_note: null,
    last_error: null,
    created_by: "u1",
    created_at: "2026-10-24T00:00:00Z",
    warnings: [],
  };
}

function rowOf(label: string) {
  return screen.getByText(label).parentElement!;
}

describe("AgentPlanningChecklist", () => {
  afterEach(cleanup);

  it("shows the three steps with the exact commands", () => {
    render(<AgentPlanningChecklist projectId="p1" analysis={base} drafts={[]} />);
    expect(screen.getByText("Install the PromptWorkspace MCP server and sign in")).toBeInTheDocument();
    expect(screen.getByText("promptworkspace-mcp login")).toBeInTheDocument();
    expect(screen.getByText("Open this repository in your coding agent and paste:")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Call the PromptWorkspace start_planning tool for this repository and follow its instructions.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Wait for drafts")).toBeInTheDocument();
    for (const label of ["Baseline", "Rules", "Specification", "Plan", "Tasks"]) {
      expect(rowOf(label)).toHaveTextContent("Waiting");
    }
  });

  it("applies the status rule per row", () => {
    render(
      <AgentPlanningChecklist
        projectId="p1"
        analysis={{ ...base, status: "baseline_ready" }}
        drafts={[draft("constitution", "pending"), draft("specify", "rejected"), draft("plan", "rejected")]}
        stageDocsPresent={{ constitution: true, plan: true, tasks: true }}
      />,
    );
    expect(rowOf("Baseline")).toHaveTextContent("Accepted");
    expect(rowOf("Rules")).toHaveTextContent("Pending review");
    expect(rowOf("Specification")).toHaveTextContent("Rejected");
    expect(rowOf("Plan")).toHaveTextContent("Accepted");
    expect(rowOf("Tasks")).toHaveTextContent("Accepted");
  });
});
