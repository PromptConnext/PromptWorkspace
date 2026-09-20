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
});
