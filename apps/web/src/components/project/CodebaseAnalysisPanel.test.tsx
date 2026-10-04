import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodebaseAnalysisPanel } from "./CodebaseAnalysisPanel";
import type { RepoAnalysisOut } from "@/lib/types";

vi.mock("@/lib/auth", () => {
  const auth = { authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } };
  return { useAuth: () => auth };
});

const originalFetch = global.fetch;

function analysis(overrides: Partial<RepoAnalysisOut> = {}): RepoAnalysisOut {
  return {
    project_id: "p1",
    status: "baseline_ready",
    required: true,
    commit_sha: "abcdef1234567",
    snapshot: {
      commit_sha: "abcdef1234567",
      default_branch: "main",
      file_count: 42,
      tree_truncated: false,
      tree_summary: "src/ (30)\ntests/ (12)",
      stack: { runtime: "node", manifests: ["package.json"], languages: ["TypeScript"] },
      excerpts: [],
      paths: [],
    },
    baseline: "# Baseline\n\nAn Express API.",
    updated_at: "2026-09-22T00:00:00Z",
    stale: false,
    ...overrides,
  };
}

describe("CodebaseAnalysisPanel", () => {
  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("shows the snapshot's stack, size and directory summary", () => {
    render(
      <CodebaseAnalysisPanel projectId="p1" analysis={analysis()} canEdit onChange={vi.fn()} />,
    );
    expect(screen.getByText(/42 files read/)).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("node")).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(screen.getByText("package.json")).toBeInTheDocument();
    expect(screen.getByText("Directory summary")).toBeInTheDocument();
    expect(screen.queryByText(/repository changed since/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-analyze" })).toBeInTheDocument();
  });

  it("flags a stale analysis and a truncated tree", () => {
    const base = analysis();
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({
          stale: true,
          snapshot: { ...base.snapshot!, tree_truncated: true },
        })}
        canEdit
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/repository changed since this analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/listed only part of this repository/i)).toBeInTheDocument();
  });

  it("offers a first analysis to an admin, and only a note to a member", () => {
    const none = analysis({ status: "none", snapshot: null, baseline: "", commit_sha: null });
    const { unmount } = render(
      <CodebaseAnalysisPanel projectId="p1" analysis={none} canEdit onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Analyze repository" })).toBeInTheDocument();
    // Nothing to PATCH before the first analysis, so no editor either.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    unmount();

    render(
      <CodebaseAnalysisPanel projectId="p1" analysis={none} canEdit={false} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /analyze/i })).not.toBeInTheDocument();
    expect(screen.getByText(/your tech lead analyzes the repository/i)).toBeInTheDocument();
  });

  it("renders a member's view, whose snapshot arrives with its excerpts withheld", () => {
    const base = analysis();
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({ snapshot: { ...base.snapshot!, excerpts: [] } })}
        canEdit={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/42 files read/)).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    // A baseline with content opens as a preview; its raw text is readable,
    // not writable.
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /analyze/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("saves an edited baseline and hands the stored analysis up", async () => {
    const saved = analysis({ baseline: "# Edited" });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => saved,
    }) as unknown as typeof fetch;
    const onChange = vi.fn();
    render(
      <CodebaseAnalysisPanel projectId="p1" analysis={analysis()} canEdit onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "# Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/projects/p1/repo-analysis");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ baseline: "# Edited" });
  });

  it("explains a refused analysis in words, not a detail code", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      json: async () => ({ detail: "daily_token_budget_exceeded" }),
    }) as unknown as typeof fetch;
    render(
      <CodebaseAnalysisPanel projectId="p1" analysis={analysis()} canEdit onChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-analyze" }));

    expect(await screen.findByText(/daily generation budget\. Try again tomorrow/i)).toBeInTheDocument();
    expect(screen.queryByText("daily_token_budget_exceeded")).not.toBeInTheDocument();
  });
});
