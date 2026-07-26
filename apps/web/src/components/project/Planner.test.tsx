import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;
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

  it("hydrates the MarkdownEditor from the persisted stage document on mount", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/specify")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "# Existing spec", updated_at: "2026-07-26T00:00:00Z" }),
        });
      }
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "plan", content: "", updated_at: null }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue("# Existing spec")).toBeInTheDocument();
    });
  });
});
