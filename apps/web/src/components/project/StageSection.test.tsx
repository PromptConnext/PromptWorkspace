import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageSection, type StageSectionProps } from "./StageSection";
import type { StageDraftOut } from "@/lib/types";

vi.mock("@/lib/auth", () => {
  const auth = { authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } };
  return { useAuth: () => auth };
});

const originalFetch = global.fetch;

function draft(overrides: Partial<StageDraftOut> = {}): StageDraftOut {
  return {
    id: "d1",
    project_id: "p1",
    stage: "tasks",
    markdown: "- [ ] T001 Do the thing",
    source: "claude-code",
    model: "claude-opus",
    status: "pending",
    stale: false,
    rejection_note: null,
    last_error: null,
    created_by: "u1",
    created_at: "2026-10-24T00:00:00Z",
    warnings: [],
    ...overrides,
  };
}

function renderSection(props: Partial<StageSectionProps> = {}) {
  render(
    <StageSection
      projectId="p1"
      stage="tasks"
      label="3 · Tasks"
      buttonLabel="Generate tasks"
      blurb="Derived from the spec and the plan."
      {...props}
    />,
  );
}

describe("StageSection", () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ stage: "tasks", content: "", updated_at: null }),
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("offers Generate, and hides it when the project is agent-planned", async () => {
    renderSection();
    expect(screen.getByRole("button", { name: "Generate tasks" })).toBeInTheDocument();
    cleanup();
    renderSection({ agentPlanned: true });
    await screen.findByRole("textbox", { name: /tasks document/i });
    expect(screen.queryByRole("button", { name: "Generate tasks" })).not.toBeInTheDocument();
  });

  it("shows the blockedBy reason only when no draft is present", () => {
    const blockedBy = "Save or generate the plan first.";
    renderSection({ blockedBy });
    expect(screen.getByText(blockedBy)).toBeInTheDocument();
    cleanup();
    renderSection({ blockedBy, draft: draft() });
    expect(screen.queryByText(blockedBy)).not.toBeInTheDocument();
  });

  it("renders the draft banner for a pending draft", () => {
    renderSection({ draft: draft(), draftCanAct: true, agentPlanned: true });
    expect(screen.getByText("Draft from your coding agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it("shows the read-only note to a non-author and no Generate", () => {
    const note = "Your Tech Lead writes this step. You can read it here once they generate it.";
    renderSection({ readOnly: true, note });
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate tasks" })).not.toBeInTheDocument();
  });
});
