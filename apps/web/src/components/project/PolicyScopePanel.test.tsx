import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyScopePanel } from "./PolicyScopePanel";
import type { PolicyTemplateOut, Project } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

const TEMPLATES: PolicyTemplateOut[] = [
  {
    id: "thai-pdpa",
    name: "Thai PDPA",
    description: "Thailand's Personal Data Protection Act.",
    body: "# Thai PDPA — Policy Scope Principles\n\nFull template body.",
  },
  {
    id: "gdpr",
    name: "GDPR",
    description: "EU General Data Protection Regulation.",
    body: "# GDPR — Policy Scope Principles\n\nFull template body.",
  },
];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    owner_id: "u1",
    lifecycle_status: "planning",
    repo_url: null,
    repo_default_branch: null,
    policy_scope: null,
    ...overrides,
  } as Project;
}

// Each PATCH call records its body so a test can assert what was actually sent.
const posted: unknown[] = [];

function mockFetch(opts: { patchFailure?: { status: number; detail: string } } = {}) {
  global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("/policy-scope") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (opts.patchFailure) {
        return Promise.resolve({
          ok: false,
          status: opts.patchFailure.status,
          json: async () => ({ detail: opts.patchFailure!.detail }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...makeProject(), policy_scope: body }),
      });
    }
    if (href.includes("/policy-templates")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => TEMPLATES });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

describe("PolicyScopePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posted.length = 0;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("renders a checkbox per template", async () => {
    mockFetch();
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={vi.fn()} />);

    expect(await screen.findByRole("checkbox", { name: /thai pdpa/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /gdpr/i })).toBeInTheDocument();
  });

  it("pre-checks templates already selected on the project", async () => {
    mockFetch();
    render(
      <PolicyScopePanel
        project={makeProject({ policy_scope: { selected: ["gdpr"], custom_text: "" } })}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );

    expect(await screen.findByRole("checkbox", { name: /gdpr/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /thai pdpa/i })).not.toBeChecked();
  });

  it("toggling a template issues a PATCH with the full new selection", async () => {
    mockFetch();
    const onChange = vi.fn();
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={onChange} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /thai pdpa/i }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ selected: ["thai-pdpa"], custom_text: "" });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(await screen.findByText(/^saved$/i)).toBeInTheDocument();
  });

  it("saves the custom text box on blur", async () => {
    mockFetch();
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={vi.fn()} />);

    const textarea = await screen.findByLabelText(/custom policy text/i);
    fireEvent.change(textarea, { target: { value: "Internal handling rules." } });
    fireEvent.blur(textarea);

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ selected: [], custom_text: "Internal handling rules." });
  });

  it("skips saving on blur when the custom text hasn't changed", async () => {
    mockFetch();
    render(
      <PolicyScopePanel
        project={makeProject({ policy_scope: { selected: [], custom_text: "Existing text" } })}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );

    const textarea = await screen.findByLabelText(/custom policy text/i);
    // Focus and blur with no edit — nothing to save.
    fireEvent.blur(textarea);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toHaveLength(0);
  });

  it("disables the inputs when readOnly and never posts, but keeps a summary", async () => {
    mockFetch();
    render(
      <PolicyScopePanel
        project={makeProject({ policy_scope: { selected: ["gdpr"], custom_text: "kept" } })}
        readOnly
        onChange={vi.fn()}
      />,
    );

    const checkbox = await screen.findByRole("checkbox", { name: /gdpr/i });
    expect(checkbox).toBeChecked();
    expect(checkbox).toBeDisabled();
    expect(screen.getByLabelText(/custom policy text/i)).toBeDisabled();
    expect(screen.getByText(/selected: gdpr/i)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
  });

  it("shows a locked message when the project is frozen", async () => {
    mockFetch({ patchFailure: { status: 409, detail: "project_frozen" } });
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /thai pdpa/i }));

    expect(await screen.findByText(/locked after repository creation/i)).toBeInTheDocument();
  });

  it("shows a length hint when the custom text is too long", async () => {
    mockFetch({ patchFailure: { status: 422, detail: "custom_text_too_long" } });
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={vi.fn()} />);

    const textarea = await screen.findByLabelText(/custom policy text/i);
    fireEvent.change(textarea, { target: { value: "x".repeat(20001) } });
    fireEvent.blur(textarea);

    expect(await screen.findByText(/keep it under 20,000 characters/i)).toBeInTheDocument();
  });

  it("shows the empty-scope hint when nothing is selected", async () => {
    mockFetch();
    render(<PolicyScopePanel project={makeProject()} readOnly={false} onChange={vi.fn()} />);

    expect(
      await screen.findByText(/select policy scope before generating the constitution/i),
    ).toBeInTheDocument();
  });
});
