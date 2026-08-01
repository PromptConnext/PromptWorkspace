import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/lib/auth";
import { WorkspaceProvider } from "@/lib/workspace";
import { WorkspaceGate } from "./WorkspaceGate";

const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  useSearchParams: () => new URLSearchParams(),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

const STUB_USER_KEY = "pz_stub_user_id";
const ACTIVE_KEY = "pz_active_workspace";

function workspace(id: string, name: string) {
  return {
    id,
    name,
    created_by: "bob",
    git_config: {},
    integration_config: {},
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

// Routes each mocked call by path so a test only states the data it cares
// about. A key may be prefixed with a method ("POST /workspaces") to
// distinguish a write from the GET on the same path.
function route(responses: Record<string, unknown>) {
  apiFetch.mockImplementation((path: string, _headers: unknown, init?: { method?: string }) => {
    const keyed = `${init?.method ?? "GET"} ${path}`;
    if (keyed in responses) return Promise.resolve(responses[keyed]);
    if (path in responses) return Promise.resolve(responses[path]);
    return Promise.resolve([]);
  });
}

function renderGate() {
  return render(
    <AuthProvider>
      <WorkspaceProvider>
        <WorkspaceGate />
      </WorkspaceProvider>
    </AuthProvider>,
  );
}

describe("WorkspaceGate invitation precedence", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STUB_USER_KEY, "bob");
    replace.mockClear();
    push.mockClear();
    apiFetch.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("shows a pending invitation instead of auto-entering the only workspace", async () => {
    // The regression: bob has a personal workspace and an unaccepted invite.
    // Auto-entering the personal one strands him with no route back.
    route({
      "/workspaces": [workspace("ws-personal", "bob's workspace")],
      "/invitations/pending": [
        {
          token: "tok-1",
          workspace_id: "ws-acme",
          workspace_name: "Acme",
          role: "member",
          invited_by: "alice",
          expires_at: "2026-09-01T00:00:00Z",
        },
      ],
    });

    renderGate();

    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(ACTIVE_KEY)).toBeNull();
  });

  it("auto-enters the single workspace when no invitation is outstanding", async () => {
    route({
      "/workspaces": [workspace("ws-personal", "bob's workspace")],
      "/invitations/pending": [],
    });

    renderGate();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/ws-personal"));
  });

  it("sends a newly created workspace to settings, not the workspace home", async () => {
    // A new workspace can create no repositories until a GitHub token is
    // configured, so setup is the landing page rather than an empty home.
    route({
      "/workspaces": [],
      "/invitations/pending": [],
      "POST /workspaces": workspace("ws-new", "Acme"),
    });

    renderGate();

    const input = await screen.findByPlaceholderText("Workspace name");
    fireEvent.change(input, { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/ws-new/settings"));
    expect(replace).not.toHaveBeenCalledWith("/w/ws-new");
  });

  it("sends an existing workspace to the workspace home, not settings", async () => {
    // The settings landing is specific to just-created workspaces; resuming a
    // remembered one must not be diverted.
    route({
      "/workspaces": [workspace("ws-old", "Existing")],
      "/invitations/pending": [],
    });

    renderGate();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/ws-old"));
    expect(replace).not.toHaveBeenCalledWith("/w/ws-old/settings");
  });

  it("accepting an invitation remembers and opens the invited workspace", async () => {
    route({
      "/workspaces": [],
      "/invitations/pending": [
        {
          token: "tok-1",
          workspace_id: "ws-acme",
          workspace_name: "Acme",
          role: "member",
          invited_by: "alice",
          expires_at: "2026-09-01T00:00:00Z",
        },
      ],
      "/invitations/tok-1/accept": { workspace_id: "ws-acme", user_id: "bob", role: "member" },
    });

    renderGate();

    const accept = await screen.findByRole("button", { name: "Accept" });
    accept.click();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/w/ws-acme"));
    expect(localStorage.getItem(ACTIVE_KEY)).toBe("ws-acme");
  });
});
