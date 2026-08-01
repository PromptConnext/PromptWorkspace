import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Planner } from "./Planner";
import type { Project } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
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

  it("renders the document upload and stage stepper for a planning-stage project", () => {
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);
    expect(screen.getByText(/upload a prd/i)).toBeInTheDocument();
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

  it("hides the Plan tab from a member who is not a workspace admin", async () => {
    members = [{ ...ADMIN_MEMBER, role: "member" }];
    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    expect(await screen.findByRole("tab", { name: /specify/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /plan/i })).not.toBeInTheDocument();
  });

  it("shows editable stage docs and the create-repository panel when tech_review", async () => {
    render(
      <Planner
        project={makeProject({ lifecycle_status: "tech_review" })}
        projectId="p1"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /generate specification/i })).toBeInTheDocument();
    await screen.findByRole("tab", { name: /plan/i });
    openTab(/plan/i);
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
      return Promise.resolve(route(href));
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
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      const match = href.match(/\/stage-documents\/(\w+)/);
      if (match) {
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

    expect(screen.getByLabelText(/engineering principles/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate rules/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/engineering principles/i), {
      target: { value: "Test first" },
    });
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
      if (href.includes("/stage-documents/")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ stage: "specify", content: "", updated_at: null }),
        });
      }
      return Promise.resolve(route(href));
    }) as unknown as typeof fetch;

    render(<Planner project={makeProject()} projectId="p1" onChange={vi.fn()} />);

    // An answer the author already typed must survive the draft.
    fireEvent.change(screen.getByLabelText(/what are we building\?/i), {
      target: { value: "My own title" },
    });
    fireEvent.click(screen.getByRole("button", { name: /draft the specify fields from the prd/i }));

    expect(await screen.findByDisplayValue("Cards are the only option")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Pay with a QR code")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My own title")).toBeInTheDocument();
    expect(screen.getByText(/drafted 2 fields from prd\.md, keeping 1/i)).toBeInTheDocument();
  });

  it("explains why a draft is unavailable when the project has no source material", async () => {
    global.fetch = vi.fn((url: RequestInfo | URL) => {
      const href = url.toString();
      if (href.includes("/prefill/specify")) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ detail: "no_source_material" }),
        });
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
    fireEvent.click(screen.getByRole("button", { name: /draft the specify fields from the prd/i }));

    expect(await screen.findByText(/upload a prd \(or write the specification\) first/i)).toBeInTheDocument();
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
});
