import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Planner } from "./Planner";
import type { Project } from "@/lib/types";

vi.mock("@/lib/auth", () => {
  // One stable object: the real AuthProvider keeps `user` and `authHeaders`
  // referentially stable per session, and useCloudGet re-fetches whenever the
  // `user` identity changes — a fresh object per render makes every click
  // flash the members fetch (and its tab-strip placeholder) back on.
  const auth = { authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } };
  return { useAuth: () => auth };
});

// Renders the refresh key it was handed, so a test can see the Planner pass it.
vi.mock("./ApprovalControl", () => ({
  ApprovalControl: ({ kind, refreshKey }: { kind: string; refreshKey?: string | number | null }) => (
    <span data-testid={`approval-${kind}`}>{refreshKey ?? ""}</span>
  ),
}));

const originalFetch = global.fetch;

// The signed-in user is a workspace admin — the "Tech Lead" role, which is
// what makes the Plan tab visible at all. Tests that care about a plain
// member reassign this.
const ADMIN_MEMBER = {
  workspace_id: "w1",
  user_id: "u1",
  email: null,
  role: "admin",
  invited_by: null,
  created_at: "2026-08-01T00:00:00Z",
};
let members: unknown[] = [ADMIN_MEMBER];

// Fallback responses every test shares, so a mock only spells out the routes
// it actually cares about.
function route(href: string) {
  if (href.includes("/members")) return { ok: true, json: async () => members };
  if (href.includes("/stage-documents/")) {
    return { ok: true, json: async () => ({ stage: "specify", content: "", updated_at: null }) };
  }
  return { ok: true, json: async () => [] };
}

function openTab(name: RegExp) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

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
    members = [ADMIN_MEMBER];
    global.fetch = vi.fn((url: RequestInfo | URL) =>
      Promise.resolve(route(url.toString())),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    localStorage.clear();
  });

  it("renders the document upload and stage stepper for a planning-stage project", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(screen.getByText(/upload a prd \(pdf or markdown\)/i)).toBeInTheDocument();
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
  });

  it("lists documents already uploaded to the project on mount", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      if (href.endsWith("/projects/p1/documents")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: "d1",
              project_id: "p1",
              title: "prd.pdf",
              mime: "application/pdf",
              source_kind: "upload",
              extract_method: "pdf",
              status: "extracted",
              created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-01T00:00:00Z",
            },
          ],
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(await screen.findByText(/prd\.pdf — extracted/i)).toBeInTheDocument();
  });

  function mockDocument(doc: Record<string, unknown>, content: string, mime: string) {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      if (href.endsWith("/content")) {
        return Promise.resolve({ ok: true, blob: async () => new Blob([content], { type: mime }) });
      }
      if (href.endsWith("/projects/p1/documents")) {
        return Promise.resolve({ ok: true, json: async () => [doc] });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;
  }

  const MARKDOWN_DOC = {
    id: "d1",
    project_id: "p1",
    title: "prd.md",
    mime: "text/markdown",
    source_kind: "upload",
    extract_method: "passthrough",
    status: "extracted",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };

  it("renders an uploaded markdown PRD as formatted text when previewed", async () => {
    mockDocument(MARKDOWN_DOC, "# Payments PRD\n\nSupport Thai QR payments.", "text/markdown");

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    (await screen.findByRole("button", { name: /^preview prd\.(md|pdf)$/i })).click();

    expect(
      await screen.findByRole("heading", { name: /payments prd/i }),
    ).toBeInTheDocument();
  });

  it("previews an uploaded PDF in a viewer frame", async () => {
    URL.createObjectURL = vi.fn(() => "blob:pdf");
    URL.revokeObjectURL = vi.fn();
    mockDocument(
      { ...MARKDOWN_DOC, title: "prd.pdf", mime: "application/pdf" },
      "%PDF-1.4",
      "application/pdf",
    );

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    (await screen.findByRole("button", { name: /^preview prd\.(md|pdf)$/i })).click();

    const frame = await screen.findByTitle("Preview of prd.pdf");
    expect(frame).toHaveAttribute("src", "blob:pdf");
  });

  it("lets a Tech Lead preview the source PRD after the project is read-only", async () => {
    mockDocument(MARKDOWN_DOC, "# Payments PRD", "text/markdown");

    render(
      <Planner
        project={makeProject({ lifecycle_status: "repo_created" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByRole("button", { name: /^preview prd\.(md|pdf)$/i })).toBeInTheDocument();
    expect(screen.queryByText(/upload a prd/i)).not.toBeInTheDocument();
  });

  it("hands the project to tech review when the Tech Lead opens the Plan tab", async () => {
    const onChange = vi.fn();
    render(<Planner project={makeProject()} projectId="p1" onChange={onChange} />);

    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);

    // The explicit "Send to Tech Lead" button is gone — opening the step the
    // Tech Lead owns is the handoff.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const posted = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .filter((href) => href.includes("/lifecycle/"));
    expect(posted.some((href) => href.includes("submit-for-review"))).toBe(true);
    expect(posted.some((href) => href.includes("start-tech-review"))).toBe(true);
    expect(screen.queryByRole("button", { name: /send to tech lead/i })).not.toBeInTheDocument();
  });

  it("withholds the tab strip until it knows what the viewer may author", async () => {
    // Membership never resolves here — the point is what renders meanwhile.
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/members")) return new Promise(() => {});
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    // Offering an authorable Plan step now and locking it a moment later
    // reads as the page changing its mind.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("shows the Plan tab read-only to a member who is not a workspace admin", async () => {
    // Hiding it made the strip read "0, 1, 3" and left the member with no way
    // to see what the Tech Lead wrote. The cloud gates authoring, not reading.
    members = [{ ...ADMIN_MEMBER, role: "member" }];
    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("tab", { name: /plan/i })).toBeInTheDocument();
    openTab(/plan/i);
    // Both stages in the tab are the Tech Lead's: the rules and the plan.
    expect(screen.getAllByText(/your tech lead writes this step/i)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /generate plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate rules/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create repository/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/deployment template/i)).not.toBeInTheDocument();
    // The document is readable, just not writable.
    const plan = within(
      screen.getByRole("heading", { name: /plan$/i }).closest("div") as HTMLElement,
    );
    for (const box of plan.getAllByRole("textbox")) {
      expect(box).toHaveAttribute("readonly");
    }
  });

  it("blocks Generate tasks for a member until the plan exists, instead of 409-ing", async () => {
    // The regression: with the Plan tab filtered out, its StageSection never
    // mounted, docPresent.plan stayed undefined, the button stayed enabled and
    // the cloud answered `spec_document_required` with nothing to act on.
    members = [{ ...ADMIN_MEMBER, role: "member" }];
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    const generate = screen.getByRole("button", { name: /generate tasks/i });
    await waitFor(() => expect(generate).toBeDisabled());
    expect(screen.getByText(/your tech lead generates it/i)).toBeInTheDocument();
  });

  it("says the roster failed to load rather than silently demoting the viewer", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/members")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/couldn't load the workspace members/i)).toBeInTheDocument();
    openTab(/plan/i);
    expect(screen.queryByRole("button", { name: /create repository/i })).not.toBeInTheDocument();
  });

  it("shows editable stage docs and the create-repository panel when tech_review", async () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
    openTab(/repository/i);
    expect(screen.getByRole("button", { name: /create repository/i })).toBeInTheDocument();
  });

  it("enables create-repository as soon as the rules are saved, without a reload", async () => {
    mockStageDocuments({ specify: "# Spec", plan: "# Plan", tasks: "# Tasks" });
    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );

    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);
    // The panel lives on the last tab and stays mounted while hidden.
    const create = screen.getByRole("button", { name: /create repository/i, hidden: true });
    await waitFor(() => expect(create).toBeDisabled());

    // Saving the rules is what unblocks it. The panel used to read the
    // constitution once on mount, so it went on claiming the document was
    // missing after it had just been written directly above.
    const rules = within(
      screen.getByRole("heading", { name: /project rules/i }).closest("div") as HTMLElement,
    );
    // The editor's textarea is the one with no form-field id of its own.
    const editor = rules
      .getAllByRole("textbox")
      .find((el) => el.tagName === "TEXTAREA" && !el.id) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Rules\n\nBe kind." } });
    fireEvent.click(rules.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(create).toBeEnabled());
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
    expect(screen.getByText(/clone this repo and open it in the promptworkspace vs code extension/i)).toBeInTheDocument();
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
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);
    // A document with content opens rendered, not as raw markdown.
    expect(await screen.findByRole("heading", { name: "Existing spec" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Specification document" })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", { name: "Raw" }),
    );
    expect(screen.getByRole("textbox", { name: "Specification document" })).toHaveValue(
      "# Existing spec",
    );
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
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    // Only the stage that has a saved document gets the line — an empty
    // stage would otherwise claim a save that never happened.
    await waitFor(() => {
      expect(screen.getAllByText(/last saved/i)).toHaveLength(1);
    });
  });

  // Stage documents keyed by stage, so a test can say which stages are already
  // done and exercise the ordering the Planner enforces.
  function mockStageDocuments(byStage: Partial<Record<string, string>>) {
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url.toString();
      const match = href.match(/\/stage-documents\/(\w+)/);
      if (match) {
        // A PATCH echoes what it was sent, like the cloud does — a save has to
        // be able to change what the rest of the page believes about a stage.
        if (init?.method === "PATCH") {
          byStage[match[1]] = JSON.parse(String(init.body)).content;
        }
        const content = byStage[match[1]] ?? "";
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stage: match[1],
            content,
            updated_at: content ? "2026-08-01T00:00:00Z" : null,
          }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;
  }

  it("asks for the specification as a structured business form, not one free-text box", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    expect(screen.getByLabelText(/what are we building\?/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/key user journeys/i)).toBeInTheDocument();
    // Required fields are empty, so there is nothing to generate from yet.
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/what are we building\?/i), {
      target: { value: "QR checkout" },
    });
    fireEvent.change(screen.getByLabelText(/problem it solves/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText(/who is it for\?/i), { target: { value: "y" } });
    fireEvent.change(screen.getByLabelText(/key user journeys/i), { target: { value: "z" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate specification/i })).toBeEnabled();
    });
  });

  it("asks the plan stage for technical context fields", async () => {
    mockStageDocuments({ specify: "# Spec" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);

    expect(await screen.findByLabelText(/language \/ runtime version/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/project type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/primary frameworks & dependencies/i)).toBeInTheDocument();
  });

  it("puts the project rules inside the Plan tab, not a step of their own", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    // The constitution is a separate document server-side, but it is the Tech
    // Lead's to write, so a business user never sees a step for it.
    expect(screen.queryByRole("tab", { name: /rules/i })).not.toBeInTheDocument();
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);

    // The rules form opens already filled in — house rules to strike and
    // extend rather than an empty box to compose.
    const principles = screen.getByLabelText(/engineering principles/i) as HTMLTextAreaElement;
    expect(principles.value).toContain("Test-first");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate rules/i })).toBeEnabled();
    });
    // Nothing gates the rules — they are the project's own, not derived from
    // an earlier document, so they enable with no stage document saved (unlike
    // "Generate plan", which is still waiting on the specification).
    expect(screen.getByRole("button", { name: /generate plan/i })).toBeDisabled();
    // A PRD describes a product, not a team's standing rules, so this is the
    // one form with no "Draft from PRD".
    expect(
      screen.queryByRole("button", { name: /draft the constitution fields/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the project rules from a member who is not a workspace admin", async () => {
    members = [{ ...ADMIN_MEMBER, role: "member" }];
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /specify/i });
    expect(screen.queryByLabelText(/engineering principles/i)).not.toBeInTheDocument();
  });

  it("locks a stage until the document it is derived from exists", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate plan/i })).toBeDisabled();
    });
    expect(screen.getByText(/waiting on 1 · specify/i)).toBeInTheDocument();

    openTab(/tasks/i);
    expect(screen.getByRole("button", { name: /generate tasks/i })).toBeDisabled();
  });

  // Plan 0027: an imported project's plan and tasks wait on a codebase
  // baseline. `analysis` is what GET /repo-analysis answers; `generate` is
  // what a generation POST answers, when a test gets that far.
  function mockImported(
    analysisStatus: string | null,
    generate?: { status: number; detail: string },
  ) {
    const byStage: Record<string, string> = { specify: "# Spec", plan: "# Plan" };
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/repo-analysis")) {
        if (analysisStatus === null) {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            project_id: "p1",
            status: analysisStatus,
            required: true,
            commit_sha: null,
            snapshot: null,
            baseline: analysisStatus === "baseline_ready" ? "# Baseline" : "",
            updated_at: null,
            stale: null,
          }),
        });
      }
      if (href.includes("/generate/") && generate) {
        return Promise.resolve({
          ok: false,
          status: generate.status,
          body: null,
          json: async () => ({ detail: generate.detail }),
        });
      }
      const match = href.match(/\/stage-documents\/(\w+)/);
      if (match) {
        const content = byStage[match[1]] ?? "";
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: match[1], content, updated_at: null }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;
  }

  const IMPORTED = { repo_url: "https://github.com/acme/app", repo_default_branch: "main" };

  it("lists the fixed seed only for a repository the platform created", async () => {
    render(
      <Planner
        project={makeProject({ ...IMPORTED, lifecycle_status: "repo_created", repo_origin: "created" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Seeded files:")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
    expect(screen.queryByText(/existing files were left untouched/i)).not.toBeInTheDocument();
    await screen.findByRole("tab", { name: /plan/i });
  });

  it("describes the non-destructive seed, not the fixed list, for an imported repository", async () => {
    render(
      <Planner
        project={makeProject({ ...IMPORTED, lifecycle_status: "repo_created", repo_origin: "imported" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/existing files were left untouched/i)).toBeInTheDocument();
    expect(screen.queryByText("Seeded files:")).not.toBeInTheDocument();
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
    await screen.findByRole("tab", { name: /plan/i });
  });

  it("holds an imported project's plan until the repository is analyzed, and points there", async () => {
    mockImported("none");
    render(<Planner project={makeProject(IMPORTED)} projectId="p1" onChange={vi.fn()} />);

    expect(await screen.findByText("Codebase analysis")).toBeInTheDocument();
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate plan/i })).toBeDisabled();
    });
    const gates = screen.getAllByRole("button", { name: /go to codebase analysis/i });
    expect(gates.length).toBeGreaterThan(0);

    fireEvent.click(gates[0]);
    expect(screen.getByRole("tab", { name: /foundation/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens the gate once the baseline exists", async () => {
    mockImported("baseline_ready");
    render(<Planner project={makeProject(IMPORTED)} projectId="p1" onChange={vi.fn()} />);

    await screen.findByText(/analyzed — the plan and tasks are written against/i);
    openTab(/tasks/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate tasks/i })).toBeEnabled();
    });
    expect(screen.queryByText(/analyze the repository first/i)).not.toBeInTheDocument();
  });

  it("does not mark Foundation done while a required analysis has no baseline", async () => {
    const scoped = { ...IMPORTED, policy_scope: { selected: ["gdpr"], custom_text: "" } };
    mockImported("none");
    const { unmount } = render(
      <Planner project={makeProject(scoped)} projectId="p1" onChange={vi.fn()} />,
    );
    await screen.findByText("Codebase analysis");
    expect(screen.queryByRole("tab", { name: /foundation completed/i })).not.toBeInTheDocument();
    unmount();

    mockImported("baseline_ready");
    render(<Planner project={makeProject(scoped)} projectId="p1" onChange={vi.fn()} />);
    expect(await screen.findByRole("tab", { name: /foundation completed/i })).toBeInTheDocument();
  });

  it("shows no analysis panel for a project started from scratch", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    expect(screen.queryByText("Codebase analysis")).not.toBeInTheDocument();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([url]) => String(url).includes("/repo-analysis"))).toBe(false);
  });

  it("maps the cloud's repo_analysis_required refusal to words and a way there", async () => {
    // The analysis read failed, so nothing gated up front — the cloud's 409
    // is the only signal left.
    mockImported(null, { status: 409, detail: "repo_analysis_required" });
    render(<Planner project={makeProject(IMPORTED)} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    const button = await screen.findByRole("button", { name: /generate tasks/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(
      await screen.findByText(/analyze the repository first — this project was imported/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("repo_analysis_required")).not.toBeInTheDocument();
  });

  it("generates tasks with no user input once the spec and plan exist", async () => {
    mockStageDocuments({ specify: "# Spec", plan: "# Plan" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate tasks/i })).toBeEnabled();
    });
    // The tasks stage carries no form fields of its own — it is derived, and
    // every input on the page belongs to the specify or plan form.
    expect(
      screen.getByText(/derived automatically from the specification and the plan/i),
    ).toBeInTheDocument();
    const taskInputs = screen
      .getAllByRole("textbox")
      .filter((el) => el.id.startsWith("tasks-"));
    expect(taskInputs).toHaveLength(0);
  });

  it("offers a route to the task board once tasks exist, and not before", async () => {
    const onOpenTasks = vi.fn();
    mockStageDocuments({ specify: "# Spec", plan: "# Plan" });
    render(
      <Planner
        project={makeProject()}
        projectId="p1"
        onChange={vi.fn()}
        onOpenTasks={onOpenTasks}
      />,
    );

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /generate tasks/i })).toBeEnabled();
    });
    expect(screen.queryByRole("button", { name: /open the task board/i })).not.toBeInTheDocument();

    // Remount against a project that already has a tasks document — the
    // presence of one is what the button keys off, not the generation event.
    cleanup();
    mockStageDocuments({ specify: "# Spec", plan: "# Plan", tasks: "# Tasks" });
    render(
      <Planner
        project={makeProject()}
        projectId="p1"
        onChange={vi.fn()}
        onOpenTasks={onOpenTasks}
      />,
    );

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    fireEvent.click(await screen.findByRole("button", { name: /open the task board/i }));
    expect(onOpenTasks).toHaveBeenCalled();
  });

  it("says the board didn't move when a save reports a failed projection", async () => {
    // Plan 0018 M4: "Last saved" on its own implied the graph agreed with the
    // document. A save the cloud could not project has to say so.
    const onOpenTasks = vi.fn();
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url.toString();
      const match = href.match(/\/stage-documents\/(\w+)/);
      if (match) {
        const content = init?.method === "PATCH" ? "# Tasks\n\nNo checklist here." : "# Tasks";
        return Promise.resolve({
          ok: true,
          json: async () => ({
            id: "sd1",
            stage: match[1],
            content,
            updated_at: "2026-08-01T00:00:00Z",
            ...(init?.method === "PATCH" ? { projection: "failed" } : {}),
          }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(
      <Planner
        project={makeProject()}
        projectId="p1"
        onChange={vi.fn()}
        onOpenTasks={onOpenTasks}
      />,
    );

    await screen.findByRole("tab", { name: /tasks/i });
    openTab(/tasks/i);
    const tasks = within(
      screen.getByRole("heading", { name: /3 · tasks/i }).closest("div") as HTMLElement,
    );
    await screen.findByRole("region", { name: "Tasks document" });
    fireEvent.click(tasks.getByRole("button", { name: "Raw" }));
    const editor = screen.getByRole("textbox", { name: "Tasks document" });
    fireEvent.change(editor, { target: { value: "# Tasks\n\nNo checklist here." } });
    fireEvent.click(tasks.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/the task board didn't update/i)).toBeInTheDocument();
    fireEvent.click(tasks.getByRole("button", { name: /open the task board/i }));
    expect(onOpenTasks).toHaveBeenCalled();
  });

  it("drafts the specify form from the PRD and leaves answers already written alone", async () => {
    const prefill = vi.fn(() => ({
      fields: {
        feature_name: "QR checkout",
        problem: "Cards are the only option",
        journeys: "Pay with a QR code",
      },
      sources: ["prd.md"],
    }));
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/prefill/specify")) {
        return Promise.resolve({ ok: true, json: async () => prefill() });
      }
      if (href.endsWith("/projects/p1/documents")) {
        return Promise.resolve({ ok: true, json: async () => [MARKDOWN_DOC] });
      }
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    // An answer the author already typed must survive the draft.
    fireEvent.change(screen.getByLabelText(/what are we building\?/i), {
      target: { value: "My own title" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /draft the specify fields from the prd/i }),
    );

    expect(await screen.findByDisplayValue("Cards are the only option")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Pay with a QR code")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My own title")).toBeInTheDocument();
    expect(screen.getByText(/drafted 2 fields from prd\.md, keeping 1/i)).toBeInTheDocument();
  });

  it("explains a draft the cloud refused for want of source material", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/prefill/specify")) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ detail: "no_source_material" }),
        });
      }
      // A PRD whose text the cloud then finds nothing in.
      if (href.endsWith("/projects/p1/documents")) {
        return Promise.resolve({ ok: true, json: async () => [MARKDOWN_DOC] });
      }
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);
    fireEvent.click(
      await screen.findByRole("button", { name: /draft the specify fields from the prd/i }),
    );

    expect(await screen.findByText(/no readable text \(scanned pdf\?\)/i)).toBeInTheDocument();
  });

  it("warns that the existing document couldn't be loaded instead of showing an empty editor", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/stage-documents/")) return Promise.reject(new Error("network down"));
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByText(/couldn't load the saved document/i).length).toBeGreaterThan(0);
    });
  });

  it("opens on the Foundation tab, which holds the planning inputs", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    const foundation = await screen.findByRole("tab", { name: /foundation/i });
    expect(foundation).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("heading", { name: /policy scope/i })).toBeInTheDocument();
    expect(screen.getByText(/upload a prd \(pdf or markdown\)/i)).toBeInTheDocument();
  });

  it("disables the policy scope panel once the project is repo_created", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/policy-templates")) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { id: "gdpr", name: "GDPR", description: "EU data protection.", body: "# GDPR" },
          ],
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(
      <Planner
        project={makeProject({ lifecycle_status: "repo_created" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("checkbox", { name: /gdpr/i })).toBeDisabled();
  });

  it("offers no PRD draft without a PRD, and points at Foundation instead", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    const hint = await screen.findByRole("button", { name: /upload a prd in foundation/i });
    expect(screen.getByText(/to draft these answers automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /draft from prd/i })).not.toBeInTheDocument();

    fireEvent.click(hint);
    expect(screen.getByRole("tab", { name: /foundation/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("names the plan draft after the specification it reads, once one exists", async () => {
    mockStageDocuments({ specify: "# Spec" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);

    const suggest = await screen.findByRole("button", {
      name: /suggest the plan fields from the specification/i,
    });
    expect(suggest).toHaveTextContent("Suggest from Spec");
    expect(suggest).toBeEnabled();
    expect(screen.getByText(/not technical\? use suggest from spec, then review/i)).toBeInTheDocument();
  });

  it("disables the plan suggestion, saying why, with neither a spec nor a PRD", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);

    const suggest = await screen.findByRole("button", {
      name: /suggest the plan fields from the specification/i,
    });
    expect(suggest).toBeDisabled();
    expect(screen.getByText(/nothing to suggest from yet/i)).toBeInTheDocument();
  });

  it("labels the Plan tab's two generations without a second step sequence", async () => {
    mockStageDocuments({ specify: "# Spec" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);

    expect(screen.getByRole("heading", { name: "Project rules (do this first)" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Implementation plan" }),
    ).toBeInTheDocument();
    // The cloud plans without the rules, so missing rules advise rather than lock.
    expect(await screen.findByText(/recommended: generate the project rules/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/language \/ runtime version/i)).toBeEnabled();
  });

  it("drops the rules recommendation once the rules exist", async () => {
    mockStageDocuments({ specify: "# Spec", constitution: "# Rules" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);
    await screen.findByRole("region", { name: "Project rules document" });
    expect(screen.queryByText(/recommended: generate the project rules/i)).not.toBeInTheDocument();
  });

  it("names every stage editor for assistive technology", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });

    openTab(/specify/i);
    expect(
      await screen.findByRole("textbox", { name: "Specification document" }),
    ).toBeInTheDocument();
    openTab(/2 · plan/i);
    expect(screen.getByRole("textbox", { name: "Project rules document" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Implementation plan document" }),
    ).toBeInTheDocument();
    openTab(/tasks/i);
    expect(screen.getByRole("textbox", { name: "Tasks document" })).toBeInTheDocument();
  });

  it("keeps the inactive stage panels out of the accessibility tree", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    const panels = screen.getAllByRole("tabpanel");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toHaveAttribute("aria-labelledby", "planner-tab-specify");
    // The rules form lives on the Plan tab and must not surface here.
    expect(screen.queryByRole("textbox", { name: /engineering principles/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /project rules/i })).not.toBeInTheDocument();
  });

  it("makes Generate the primary action until the stage has a document", async () => {
    mockStageDocuments({ specify: "# Spec" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/2 · plan/i);

    await screen.findByRole("button", { name: /suggest the plan fields/i });
    expect(screen.getByRole("button", { name: /generate plan/i })).toHaveClass("bg-slate-900");
    openTab(/specify/i);
    await screen.findByRole("region", { name: "Specification document" });
    expect(screen.getByRole("button", { name: /generate specification/i })).not.toHaveClass(
      "bg-slate-900",
    );
    expect(screen.getByRole("button", { name: "Continue to Plan" })).toHaveClass("bg-slate-900");
  });

  it("marks each tab done once its step has produced something", async () => {
    mockStageDocuments({ specify: "# Spec", plan: "# Plan" });
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    expect(await screen.findByRole("tab", { name: "1 · Specify completed" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "2 · Plan completed" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "3 · Tasks" })).toHaveAttribute(
      "data-status",
      "not-started",
    );
    expect(screen.getByRole("tab", { name: "4 · Repository" })).toBeInTheDocument();
    // Neither a PRD nor a policy scope yet; Foundation is just the open tab.
    expect(screen.getByRole("tab", { name: "0 · Foundation" })).toHaveAttribute(
      "data-status",
      "current",
    );
  });

  it("marks Foundation done for a saved policy scope or an uploaded PRD", async () => {
    render(
      <Planner
        project={makeProject({ policy_scope: { selected: ["gdpr"], custom_text: "" } })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("tab", { name: "0 · Foundation completed" }),
    ).toBeInTheDocument();

    cleanup();
    mockDocument(MARKDOWN_DOC, "# PRD", "text/markdown");
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(
      await screen.findByRole("tab", { name: "0 · Foundation completed" }),
    ).toBeInTheDocument();
  });

  it("marks Repository done once the repository is created", async () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "repo_created" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("tab", { name: "4 · Repository completed" }),
    ).toBeInTheDocument();
  });

  it("introduces Foundation as optional and continues to Specify", async () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /foundation/i });

    expect(screen.getByText(/both parts are optional/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue to Specify" }));
    expect(screen.getByRole("tab", { name: /specify/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers the next stage once a stage has its document, and walks the flow", async () => {
    mockStageDocuments({ specify: "# Spec", plan: "# Plan", tasks: "# Tasks" });
    const onOpenTasks = vi.fn();
    render(
      <Planner
        project={makeProject()}
        projectId="p1"
        onChange={vi.fn()}
        onOpenTasks={onOpenTasks}
      />,
    );
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    fireEvent.click(await screen.findByRole("button", { name: "Continue to Plan" }));
    expect(screen.getByRole("tab", { name: /2 · plan/i })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: "Continue to Tasks" }));
    expect(screen.getByRole("tab", { name: /3 · tasks/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // On Tasks the board is the primary next step; Repository sits beside it.
    const board = screen.getByRole("button", { name: /^open the task board$/i });
    expect(board).toHaveClass("bg-slate-900");
    fireEvent.click(screen.getByRole("button", { name: "Continue to Repository" }));
    expect(screen.getByRole("tab", { name: /4 · repository/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows no Continue before the stage has a document", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);
    await screen.findByRole("textbox", { name: "Specification document" });
    expect(screen.queryByRole("button", { name: /continue to plan/i })).not.toBeInTheDocument();
  });

  it("offers Continue after a manual save gives the stage a document", async () => {
    mockStageDocuments({});
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    const editor = await screen.findByRole("textbox", { name: "Specification document" });
    fireEvent.change(editor, { target: { value: "# Hand-written spec" } });
    const panel = within(screen.getByRole("tabpanel"));
    fireEvent.click(panel.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("button", { name: "Continue to Plan" })).toBeInTheDocument();
  });

  it("hands the approval chip a new refresh key each time the document is saved", async () => {
    let saved = 0;
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const href = url.toString();
      const match = href.match(/\/stage-documents\/(\w+)/);
      if (match) {
        if (init?.method === "PATCH") saved += 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stage: match[1],
            content: saved ? "# Spec" : "",
            updated_at: saved ? `saved-${saved}` : null,
          }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    await screen.findByRole("tab", { name: /specify/i });
    openTab(/specify/i);

    const editor = await screen.findByRole("textbox", { name: "Specification document" });
    fireEvent.change(editor, { target: { value: "# Spec" } });
    const save = () =>
      fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: /^save$/i }));
    save();
    const chip = await screen.findByTestId("approval-intent_approval");
    await waitFor(() => expect(chip).toHaveTextContent("saved-1"));

    // Editing the saved document and saving again moves the key on.
    fireEvent.click(within(screen.getByRole("tabpanel")).getByRole("button", { name: "Raw" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Specification document" }), {
      target: { value: "# Spec edited" },
    });
    save();
    await waitFor(() => expect(chip).toHaveTextContent("saved-2"));
  });
});
