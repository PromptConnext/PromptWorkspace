import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateRepositoryPanel } from "./CreateRepositoryPanel";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }), user: { id: "u1" } }),
}));

const originalFetch = global.fetch;

function mockFetch(createResponse?: { ok: boolean; status?: number; detail?: string }) {
  global.fetch = vi.fn((url: RequestInfo | URL) => {
    const href = url.toString();
    if (href.includes("/lifecycle/create-repository")) {
      const status = createResponse?.status ?? (createResponse?.ok === false ? 400 : 200);
      return Promise.resolve({
        ok: createResponse?.ok ?? true,
        status,
        json: async () =>
          createResponse?.ok === false
            ? { detail: createResponse.detail }
            : { id: "p1", repo_url: "https://github.com/acme/widget", lifecycle_status: "repo_created" },
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }) as unknown as typeof fetch;
}

describe("CreateRepositoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("creates the repository on the happy path", async () => {
    mockFetch({ ok: true });
    const onCreated = vi.fn();
    render(
      <CreateRepositoryPanel
        projectId="p1"
        projectName="Widget App"
        onCreated={onCreated}
        constitutionReady
        tasksReady
      />,
    );

    const button = await screen.findByRole("button", { name: /create repository/i });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("disables the create button with a hint when the constitution doc is empty", async () => {
    mockFetch();
    render(
      <CreateRepositoryPanel
        projectId="p1"
        projectName="Widget App"
        onCreated={vi.fn()}
        constitutionReady={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create repository/i })).toBeDisabled();
    });
    expect(screen.getByText(/seeds AGENTS\.md in the new repo/i)).toBeInTheDocument();
  });

  it("disables the create button with a hint when the tasks doc is missing", async () => {
    mockFetch();
    render(
      <CreateRepositoryPanel
        projectId="p1"
        projectName="Widget App"
        onCreated={vi.fn()}
        constitutionReady
        tasksReady={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create repository/i })).toBeDisabled();
    });
    expect(screen.getByText(/first — the planner locks once the repository exists/i)).toBeInTheDocument();
  });

  it("renders a human sentence for github_not_configured", async () => {
    mockFetch({ ok: false, status: 400, detail: "github_not_configured" });
    render(
      <CreateRepositoryPanel
        projectId="p1"
        projectName="Widget App"
        onCreated={vi.fn()}
        constitutionReady
        tasksReady
        workspaceId="ws1"
      />,
    );

    const button = await screen.findByRole("button", { name: /create repository/i });
    await waitFor(() => expect(button).not.toBeDisabled());

    fireEvent.click(button);

    expect(
      await screen.findByText(/no github connection for this workspace yet/i),
    ).toBeInTheDocument();
    // The fix lives on another page, so the message has to carry what to put
    // there: the scopes, and that GitHub validates the token on save.
    expect(screen.getByText(/fine-grained personal access token/i)).toBeInTheDocument();
    expect(screen.getByText("Administration")).toBeInTheDocument();
    expect(screen.getByText("Webhooks")).toBeInTheDocument();
    expect(screen.getByText(/verified against github before it is stored/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /workspace settings/i })).toHaveAttribute(
      "href",
      "/w/ws1/settings",
    );
  });

  // Plan 0027 M4: an imported repository gets the cloud's seed preview, read
  // from the live tree, in place of the fixed list a new repository gets.
  describe("imported repository", () => {
    const project = {
      id: "p1",
      name: "Widget App",
      workspace_id: "ws1",
      owner_id: "u1",
      onboarding_state: "",
      stage_state: {},
      lifecycle_status: "tech_review",
      repo_url: "https://github.com/acme/widget",
      repo_default_branch: "main",
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    } as const;

    function mockPreview(
      preview: Record<string, unknown>,
      createResponse?: { ok: boolean; status?: number; detail?: string },
    ) {
      global.fetch = vi.fn((url: RequestInfo | URL) => {
        const href = url.toString();
        if (href.includes("/repository/seed-preview")) {
          return Promise.resolve({ ok: true, json: async () => preview });
        }
        if (href.includes("/lifecycle/create-repository")) {
          return Promise.resolve({
            ok: createResponse?.ok ?? true,
            status: createResponse?.status ?? 200,
            json: async () => ({ detail: createResponse?.detail }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as unknown as typeof fetch;
    }

    it("renders what will be added, moved aside and left alone", async () => {
      mockPreview({
        write: ["docs/promptzone/README.md", "docs/scope.md", "AGENTS.md"],
        relocated: [{ from: "README.md", to: "docs/promptzone/README.md" }],
        skipped: ["Dockerfile"],
        conflicts: [],
      });
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      expect(await screen.findByText("README.md → docs/promptzone/README.md")).toBeInTheDocument();
      expect(screen.getByText("docs/scope.md")).toBeInTheDocument();
      expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
      expect(screen.getByText("Dockerfile")).toBeInTheDocument();
      // A relocated file is listed once, under its move — not again as an add.
      expect(screen.queryByText("docs/promptzone/README.md")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /create repository/i })).toBeEnabled();
    });

    it("disables creation while the preview reports a conflicting workflow", async () => {
      mockPreview({
        write: ["AGENTS.md"],
        relocated: [],
        skipped: [],
        conflicts: [".github/workflows/deploy.yml"],
      });
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      expect(await screen.findByText(".github/workflows/deploy.yml")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /create repository/i })).toBeDisabled();
      expect(screen.getByText(/can't be created until the conflicting files/i)).toBeInTheDocument();
    });

    it("maps repo_moved_during_seed and re-reads the preview", async () => {
      mockPreview(
        { write: ["AGENTS.md"], relocated: [], skipped: [], conflicts: [] },
        { ok: false, status: 409, detail: "repo_moved_during_seed" },
      );
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      const button = await screen.findByRole("button", { name: /create repository/i });
      await screen.findByText("AGENTS.md");
      fireEvent.click(button);

      expect(await screen.findByText(/nothing was written/i)).toBeInTheDocument();
      expect(screen.queryByText("repo_moved_during_seed")).not.toBeInTheDocument();
      const previewCalls = () =>
        (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
          String(url).includes("/repository/seed-preview"),
        ).length;
      await waitFor(() => expect(previewCalls()).toBe(2));
    });

    it("maps default_branch_protected", async () => {
      mockPreview(
        { write: ["AGENTS.md"], relocated: [], skipped: [], conflicts: [] },
        { ok: false, status: 409, detail: "default_branch_protected" },
      );
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      const button = await screen.findByRole("button", { name: /create repository/i });
      await screen.findByText("AGENTS.md");
      fireEvent.click(button);

      expect(await screen.findByText(/branch protection/i)).toBeInTheDocument();
      expect(screen.queryByText("default_branch_protected")).not.toBeInTheDocument();
    });

    it("maps repo_tree_too_large when the preview itself is refused", async () => {
      global.fetch = vi.fn((url: RequestInfo | URL) => {
        if (url.toString().includes("/repository/seed-preview")) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({ detail: "repo_tree_too_large" }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as unknown as typeof fetch;
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      expect(
        await screen.findByText(/directory in this repository is too large/i),
      ).toBeInTheDocument();
      expect(screen.queryByText("repo_tree_too_large")).not.toBeInTheDocument();
    });

    it("maps deploy_workflow_conflict from create-repository to words", async () => {
      mockPreview(
        { write: ["AGENTS.md"], relocated: [], skipped: [], conflicts: [] },
        { ok: false, status: 409, detail: "deploy_workflow_conflict" },
      );
      render(
        <CreateRepositoryPanel
          projectId="p1"
          projectName="Widget App"
          onCreated={vi.fn()}
          constitutionReady
          tasksReady
          project={project}
        />,
      );

      const button = await screen.findByRole("button", { name: /create repository/i });
      await screen.findByText("AGENTS.md");
      fireEvent.click(button);

      expect(
        await screen.findByText(/already has a \.github\/workflows\/deploy\.yml/i),
      ).toBeInTheDocument();
      expect(screen.queryByText("deploy_workflow_conflict")).not.toBeInTheDocument();
    });
  });
});
