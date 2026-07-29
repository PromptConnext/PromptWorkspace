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

  it("shows read-only docs and a Start tech review button when pending_tech_review", () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "pending_tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/sent to tech lead/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate specification/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start tech review/i })).toBeInTheDocument();
  });

  it("shows editable stage docs and the create-repository panel when tech_review", () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create repository/i })).toBeInTheDocument();
  });

  it("shows the success card and read-only docs when repo_created", () => {
    render(
      <Planner
        project={makeProject({
          lifecycle_status: "repo_created",
          repo_url: "https://github.com/acme/widget",
          repo_default_branch: "main",
        })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/repository created/i)).toBeInTheDocument();
    expect(screen.getByText("https://github.com/acme/widget")).toBeInTheDocument();
    expect(screen.getByText(/clone this repo in the promptzone desktop app/i)).toBeInTheDocument();
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

  it("shows when a persisted stage document was last saved", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/specify")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stage: "specify",
            content: "# Existing spec",
            updated_at: "2026-07-26T00:00:00Z",
          }),
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

    // Only the stage that has a saved document gets the line — an empty
    // stage would otherwise claim a save that never happened.
    await waitFor(() => {
      expect(screen.getAllByText(/last saved/i)).toHaveLength(1);
    });
  });

  it("warns that the existing document couldn't be loaded instead of showing an empty editor", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) return Promise.reject(new Error("network down"));
      return Promise.resolve({ ok: true, json: async () => [] });
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText(/couldn't load the saved document/i).length).toBeGreaterThan(0);
    });
  });
});
