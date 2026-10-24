import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodebaseAnalysisPanel } from "./CodebaseAnalysisPanel";
import type { RepoAnalysisOut, StageDraftOut, StageKind } from "@/lib/types";

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
    source: "agent",
    model: "claude",
    ...overrides,
  };
}

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
  });

  it("52 of 53 files read lists the skipped file and why", () => {
    const base = analysis();
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({
          snapshot: {
            ...base.snapshot!,
            file_count: 52,
            skipped: [{ path: "certs/<b>server</b>.pem", reason: "secret" }],
            skipped_count: 1,
          },
        })}
        canEdit
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/52 of 53 files read/)).toBeInTheDocument();
    expect(screen.getByText("1 file skipped")).toBeInTheDocument();
    // A repository path is text, never markup.
    expect(screen.getByText("certs/<b>server</b>.pem")).toBeInTheDocument();
    expect(screen.getByText(/credential-shaped file, never read/)).toBeInTheDocument();
  });

  it("counts every skipped file and lists a vendored directory once", () => {
    const base = analysis();
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({
          snapshot: {
            ...base.snapshot!,
            skipped: [
              { path: "node_modules/", reason: "vendored" },
              { path: "public/logo.png", reason: "binary" },
            ],
            skipped_count: 900,
          },
        })}
        canEdit
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/42 of 942 files read/)).toBeInTheDocument();
    expect(screen.getByText(/vendored or build directory/)).toBeInTheDocument();
    expect(screen.getByText(/binary file/)).toBeInTheDocument();
    expect(screen.getByText("900 files skipped")).toBeInTheDocument();
  });

  it("shows a member the skipped count without an empty list to expand", () => {
    // The API drops secret-shaped names for a member, so the list can be empty
    // while the count is not.
    const base = analysis();
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({
          snapshot: { ...base.snapshot!, file_count: 52, skipped: [], skipped_count: 1 },
        })}
        canEdit={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/52 of 53 files read/)).toBeInTheDocument();
    const count = screen.getByText("1 file skipped");
    expect(count.tagName).not.toBe("SUMMARY");
    expect(count.closest("details")).toBeNull();
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

  it("shows the checklist instead of the Analyze button for a required analysis", () => {
    const none = analysis({ status: "none", snapshot: null, baseline: "", commit_sha: null });
    const { unmount } = render(
      <CodebaseAnalysisPanel projectId="p1" analysis={none} canEdit onChange={vi.fn()} />,
    );
    expect(screen.getByText("promptworkspace-mcp login")).toBeInTheDocument();
    expect(screen.getByText("Wait for drafts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /analyze/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText(/Your coding agent reads the repository and drafts the baseline/)).toBeInTheDocument();
    unmount();

    render(
      <CodebaseAnalysisPanel projectId="p1" analysis={none} canEdit={false} onChange={vi.fn()} />,
    );
    expect(screen.getByText("Wait for drafts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /analyze/i })).not.toBeInTheDocument();
  });

  it("marks the baseline row accepted for a pre-existing cloud baseline and keeps stage rows waiting", () => {
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis({ source: "cloud", model: "typhoon" })}
        canEdit
        onChange={vi.fn()}
      />,
    );
    // The rendered baseline preview has its own "Baseline" heading.
    const row = screen.getAllByText("Baseline").find((el) => el.tagName === "SPAN");
    expect(row!.parentElement).toHaveTextContent("Accepted");
    for (const label of ["Rules", "Specification", "Plan", "Tasks"]) {
      expect(screen.getByText(label).parentElement).toHaveTextContent("Waiting");
    }
  });

  it("marks a stage row pending review when a draft exists", () => {
    render(
      <CodebaseAnalysisPanel
        projectId="p1"
        analysis={analysis()}
        canEdit
        onChange={vi.fn()}
        drafts={[draft("specify", "pending")]}
      />,
    );
    expect(screen.getByText("Specification").parentElement).toHaveTextContent("Pending review");
    expect(screen.getByText("Rules").parentElement).toHaveTextContent("Waiting");
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

  it("still lets an admin edit and save the baseline", async () => {
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
});
