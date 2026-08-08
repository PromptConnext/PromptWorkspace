import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantFactCard } from "./AssistantFactCard";
import type { LineageFacts } from "@/lib/types";

function facts(over: Partial<LineageFacts> = {}): LineageFacts {
  return {
    scope: "requirement",
    node_type: "requirements",
    node_id: "r1",
    title: "Login must support SSO",
    status: "in_progress",
    specs_total: 2,
    tasks_total: 4,
    tasks_done: 2,
    task_status_counts: { todo: 1, in_progress: 1, verified: 2 },
    artifacts_total: 3,
    agent_runs: [{ id: "a1", status: "failed" }],
    ...over,
  };
}

describe("AssistantFactCard", () => {
  // This repo's vitest config has no `globals: true` / setupFiles, so
  // @testing-library/react's auto-cleanup never registers — every test file
  // that renders must call cleanup itself (see DiscussionThread.test.tsx).
  afterEach(() => {
    cleanup();
  });

  it("shows the title and status", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText("Login must support SSO")).toBeInTheDocument();
    // Scoped to "status · in_progress" rather than a bare /in_progress/: the
    // default fixture's task_status_counts also has an "in_progress" key, so
    // an unscoped regex matches both the status line and the breakdown line.
    expect(screen.getByText(/status · in_progress/)).toBeInTheDocument();
  });

  it("marks the card as coming from the graph, not the model", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText(/from the task graph/i)).toBeInTheDocument();
  });

  it("renders the task counts", () => {
    render(<AssistantFactCard facts={facts()} />);
    expect(screen.getByText(/2 specs · 4 tasks · 2 done · 3 artifacts/)).toBeInTheDocument();
  });

  it("omits zero-valued fields rather than printing 0", () => {
    render(
      <AssistantFactCard
        facts={facts({ specs_total: 0, artifacts_total: 0, agent_runs: [], task_status_counts: {} })}
      />,
    );
    expect(screen.queryByText(/specs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/artifacts/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/agent runs?/i)).not.toBeInTheDocument();
  });

  it("omits the status line when status is null", () => {
    render(<AssistantFactCard facts={facts({ status: null })} />);
    expect(screen.queryByText(/status/i)).not.toBeInTheDocument();
  });
});
