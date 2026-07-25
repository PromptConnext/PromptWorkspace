import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Planner } from "./Planner";
import type { Project } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    owner_id: "u1",
    lifecycle_status: "planning",
    repo_url: null,
    repo_default_branch: null,
    ...overrides,
  } as Project;
}

describe("Planner", () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("renders the document upload and stage stepper for a planning-stage project", () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(screen.getByText(/upload a prd/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
  });

  it("shows a read-only notice instead of the stepper once past planning", () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "pending_tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/sent to tech lead/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate specification/i })).not.toBeInTheDocument();
  });
});
