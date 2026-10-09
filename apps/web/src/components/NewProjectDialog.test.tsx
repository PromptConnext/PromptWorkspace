import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    authHeaders: () => ({ Authorization: "Bearer test" }),
    user: { id: "u1" },
  }),
}));

const originalFetch = global.fetch;

// URL-keyed fetch stub, same convention as CreateRepositoryPanel.test.tsx.
// `routes` maps a URL substring to either a response body (200) or
// {status, detail} for an error response.
function mockFetch(routes: Record<string, unknown | { status: number; detail: string }>) {
  global.fetch = vi.fn((url: RequestInfo | URL) => {
    const href = url.toString();
    const match = Object.entries(routes).find(([key]) => href.includes(key));
    if (!match) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    const [, value] = match;
    if (value && typeof value === "object" && "status" in value && "detail" in value) {
      const { status, detail } = value as { status: number; detail: string };
      return Promise.resolve({ ok: false, status, json: async () => ({ detail }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => value });
  }) as unknown as typeof fetch;
}

function lastFetchBody(urlSubstring: string): Record<string, unknown> {
  const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find((args: unknown[]) =>
    (args[0] as RequestInfo | URL).toString().includes(urlSubstring),
  );
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

const REPO_LIST_PATH = "/integrations/github/repos";

function repo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    full_name: "acme/storyapp",
    name: "storyapp",
    html_url: "https://github.com/acme/storyapp",
    default_branch: "main",
    private: true,
    archived: false,
    empty: false,
    pushed_at: "2026-09-15T00:00:00Z",
    ...overrides,
  };
}

describe("NewProjectDialog", () => {
  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it("does not render when closed", () => {
    mockFetch({});
    render(
      <NewProjectDialog open={false} workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers both choices", () => {
    mockFetch({});
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByText("Start from scratch")).toBeInTheDocument();
    expect(screen.getByText("Import a GitHub repository")).toBeInTheDocument();
  });

  it("scratch path POSTs with no import_repo_full_name", async () => {
    const onCreated = vi.fn();
    mockFetch({ "/projects": { id: "p1", name: "My App" } });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.click(screen.getByText("Start from scratch"));
    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "My App" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "p1", name: "My App" }));

    const body = lastFetchBody("/projects");
    expect(body).toEqual({ name: "My App", workspace_id: "ws1" });
    expect(body.import_repo_full_name).toBeUndefined();
  });

  it("Create shows a pending state until navigation", async () => {
    // The parent navigates on onCreated; until the project page replaces this
    // one, the dialog stays and says so, instead of closing onto the old list.
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockFetch({ "/projects": { id: "p1", name: "My App" } });
    render(<NewProjectDialog open workspaceId="ws1" onClose={onClose} onCreated={onCreated} />);

    fireEvent.click(screen.getByText("Start from scratch"));
    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "My App" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Opening My App…");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closing while a created project opens leaves a fresh dialog next time", async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    mockFetch({ "/projects": { id: "p1", name: "My App" } });
    const { rerender } = render(
      <NewProjectDialog open workspaceId="ws1" onClose={onClose} onCreated={onCreated} />,
    );
    fireEvent.click(screen.getByText("Start from scratch"));
    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "My App" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<NewProjectDialog open={false} workspaceId="ws1" onClose={onClose} onCreated={onCreated} />);
    rerender(<NewProjectDialog open workspaceId="ws1" onClose={onClose} onCreated={onCreated} />);

    fireEvent.click(screen.getByText("Start from scratch"));
    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "Second" },
    });
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("lists repositories and filters by name", async () => {
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: "acme-bot",
        repositories: [repo(), repo({ full_name: "acme/other", name: "other" })],
        truncated: false,
      },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    await screen.findByText("storyapp");
    expect(screen.getByText("other")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Filter repositories…"), {
      target: { value: "story" },
    });
    expect(screen.getByText("storyapp")).toBeInTheDocument();
    expect(screen.queryByText("other")).not.toBeInTheDocument();
  });

  it("disables archived rows but keeps an empty-flagged row selectable with an advisory hint", async () => {
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: "acme-bot",
        repositories: [
          repo({ full_name: "acme/vintage", name: "vintage", archived: true }),
          repo({ full_name: "acme/blank-slate", name: "blank-slate", empty: true }),
        ],
        truncated: false,
      },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    const archivedRow = await screen.findByRole("button", { name: /vintage/ });
    const emptyRow = screen.getByRole("button", { name: /blank-slate/ });

    expect(archivedRow).toBeDisabled();
    expect(archivedRow.textContent).toMatch(/archived on github/i);
    expect(emptyRow).not.toBeDisabled();
    expect(emptyRow.textContent).toMatch(/github reports no commits yet/i);
    expect(emptyRow.textContent).toMatch(/you can still import it/i);
  });

  it("shows a clear message when the server refuses an empty repository", async () => {
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: "acme-bot",
        repositories: [repo({ full_name: "acme/blank-slate", name: "blank-slate", empty: true })],
        truncated: false,
      },
      "/projects": { status: 400, detail: "repo_is_empty" },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    fireEvent.click(await screen.findByRole("button", { name: /blank-slate/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(/no commits on its default branch/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("repo_is_empty")).not.toBeInTheDocument();
  });

  it("names the connected owner when the repository list is empty", async () => {
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: null,
        repositories: [],
        truncated: false,
      },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    expect((await screen.findAllByText(/acme/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /workspace settings/i })).toHaveAttribute(
      "href",
      "/w/ws1/settings",
    );
  });

  it("blocks create until the seed-file list is consented to", async () => {
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: "acme-bot",
        repositories: [repo()],
        truncated: false,
      },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    fireEvent.click(await screen.findByRole("button", { name: /storyapp/ }));

    // Confirmation step: says what the seed will and won't do (the exact list
    // is the create-repository panel's live preview), and Create starts
    // disabled.
    expect(screen.getByText(/never overwritten/i)).toBeInTheDocument();
    expect(screen.getByText("docs/promptworkspace/")).toBeInTheDocument();
    expect(screen.getByText(/\.github\/workflows\/deploy\.yml/)).toBeInTheDocument();
    expect(screen.queryByText("AGENTS.md")).not.toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "Create" });
    expect(createButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(createButton).not.toBeDisabled();
  });

  it("import path POSTs import_repo_full_name after consent", async () => {
    const onCreated = vi.fn();
    mockFetch({
      [REPO_LIST_PATH]: {
        owner: "acme",
        owner_type: "Organization",
        account_login: "acme-bot",
        repositories: [repo()],
        truncated: false,
      },
      "/projects": { id: "p2", name: "storyapp", repo_url: "https://github.com/acme/storyapp" },
    });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    fireEvent.click(await screen.findByRole("button", { name: /storyapp/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    const body = lastFetchBody("/projects");
    expect(body).toEqual({
      name: "storyapp",
      workspace_id: "ws1",
      import_repo_full_name: "acme/storyapp",
    });
  });

  it("renders a human sentence for github_not_configured", async () => {
    mockFetch({ [REPO_LIST_PATH]: { status: 400, detail: "github_not_configured" } });
    render(<NewProjectDialog open workspaceId="ws1" onClose={vi.fn()} onCreated={vi.fn()} />);

    fireEvent.click(screen.getByText("Import a GitHub repository"));
    expect(
      await screen.findByText(/no github connection for this workspace yet/i),
    ).toBeInTheDocument();
  });
});
