import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentTemplatePanel } from "./DeploymentTemplatePanel";
import type { DeploymentTemplateOut, Project } from "@/lib/types";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

const TEMPLATES: DeploymentTemplateOut[] = [
  {
    id: "static-r2",
    name: "Static site → PromptZone hosting",
    description: "A plain site published to PromptZone-managed storage.",
    stack: "static",
    delivery_kind: "embedded_url",
    provider: "platform-r2",
    provider_label: "PromptZone hosting",
    provider_is_platform_owned: true,
    embeddable: true,
    required_secrets: ["PZ_R2_ACCESS_KEY_ID"],
    required_vars: ["PZ_PROJECT_ID"],
    scaffold_paths: [".github/workflows/deploy.yml", "site/index.html"],
    workflow_preview: "name: Deploy preview\non:\n  push:\n",
  },
  {
    id: "nextjs-vercel",
    name: "Next.js → Vercel",
    description: "A Next.js app deployed to your Vercel account.",
    stack: "nextjs",
    delivery_kind: "embedded_url",
    provider: "vercel",
    provider_label: "Vercel",
    provider_is_platform_owned: false,
    embeddable: true,
    required_secrets: ["PZ_VERCEL_TOKEN"],
    required_vars: ["PZ_PROJECT_ID"],
    scaffold_paths: [".github/workflows/deploy.yml", "app/page.tsx"],
    workflow_preview: "name: Deploy preview\n",
  },
];

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "P",
    workspace_id: "w1",
    owner_id: "u1",
    lifecycle_status: "tech_review",
    repo_url: null,
    repo_default_branch: null,
    policy_scope: null,
    deployment_config: null,
    deployment_state: null,
    ...overrides,
  } as Project;
}

const posted: unknown[] = [];

function mockFetch(opts: { patchFailure?: { status: number; detail: string } } = {}) {
  global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const href = url.toString();
    if (href.includes("/deployment-config") && init?.method === "PATCH") {
      posted.push(JSON.parse(String(init.body)));
      if (opts.patchFailure) {
        return Promise.resolve({
          ok: false,
          status: opts.patchFailure.status,
          json: async () => ({ detail: opts.patchFailure!.detail }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => makeProject() } as Response);
    }
    if (href.includes("/deployment-templates")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => TEMPLATES } as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  posted.length = 0;
  mockFetch();
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DeploymentTemplatePanel", () => {
  it("offers every template as a single-select choice", async () => {
    render(
      <DeploymentTemplatePanel
        project={makeProject()}
        workspaceId="w1"
        readOnly={false}
        onChange={() => {}}
      />,
    );
    await screen.findByText("Static site → PromptZone hosting");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    // Single-select is the structural difference from PolicyScopePanel: a
    // project deploys one way, not several.
    radios.forEach((r) => expect(r).toHaveAttribute("type", "radio"));
  });

  it("saves the chosen template immediately and tells the parent", async () => {
    const onChange = vi.fn();
    render(
      <DeploymentTemplatePanel
        project={makeProject()}
        workspaceId="w1"
        readOnly={false}
        onChange={onChange}
      />,
    );
    await screen.findByText("Static site → PromptZone hosting");
    fireEvent.click(screen.getAllByRole("radio")[0]);

    await waitFor(() => expect(posted).toEqual([{ template_id: "static-r2" }]));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("rolls the selection back and explains when the server refuses", async () => {
    mockFetch({ patchFailure: { status: 409, detail: "project_frozen" } });
    render(
      <DeploymentTemplatePanel
        project={makeProject()}
        workspaceId="w1"
        readOnly={false}
        onChange={() => {}}
      />,
    );
    await screen.findByText("Static site → PromptZone hosting");
    fireEvent.click(screen.getAllByRole("radio")[0]);

    expect(await screen.findByText(/Locked after repository creation/i)).toBeInTheDocument();
    // The radio must not keep showing a choice that was refused.
    await waitFor(() => expect(screen.getAllByRole("radio")[0]).not.toBeChecked());
  });

  it("previews exactly what a template will commit, without another request", async () => {
    render(
      <DeploymentTemplatePanel
        project={makeProject()}
        workspaceId="w1"
        readOnly={false}
        onChange={() => {}}
      />,
    );
    await screen.findByText("Static site → PromptZone hosting");
    fireEvent.click(screen.getAllByRole("button", { name: /See what it commits/i })[0]);

    expect(await screen.findByText("site/index.html")).toBeInTheDocument();
    expect(screen.getByText(/name: Deploy preview/)).toBeInTheDocument();

    // The claim is that no per-template request exists — the list endpoint
    // ships scaffold paths and workflow text inline. Counting total calls
    // would just measure unrelated refetches, so assert the shape of the
    // URLs instead.
    const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    expect(urls.every((u) => !/\/deployment-templates\/[^?]/.test(u))).toBe(true);
  });

  it("nudges when nothing is selected", async () => {
    render(
      <DeploymentTemplatePanel
        project={makeProject()}
        workspaceId="w1"
        readOnly={false}
        onChange={() => {}}
      />,
    );
    expect(
      await screen.findByText(/no live application to review/i),
    ).toBeInTheDocument();
  });

  it("warns, but does not block, when the provider needs an account", async () => {
    render(
      <DeploymentTemplatePanel
        project={makeProject({ deployment_config: { template_id: "nextjs-vercel" } })}
        workspaceId="w1"
        readOnly={false}
        onChange={() => {}}
      />,
    );
    expect(await screen.findByText(/must be connected in/i)).toBeInTheDocument();
    // Still selectable — the hard failure belongs at repository creation.
    expect(screen.getAllByRole("radio")[1]).not.toBeDisabled();
  });

  it("shows a frozen project what it deployed with, and offers no controls", async () => {
    render(
      <DeploymentTemplatePanel
        project={makeProject({
          lifecycle_status: "repo_created",
          deployment_config: { template_id: "static-r2" },
        })}
        workspaceId="w1"
        readOnly
        onChange={() => {}}
      />,
    );
    expect(await screen.findByText(/Deploying with/i)).toBeInTheDocument();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });
});
