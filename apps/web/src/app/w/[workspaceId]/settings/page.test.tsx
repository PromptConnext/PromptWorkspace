import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import WorkspaceSettingsPage from "./page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/DeployConnectionsPanel", () => ({ DeployConnectionsPanel: () => null }));
vi.mock("@/components/GithubConnectionForm", () => ({ GithubConnectionForm: () => null }));
vi.mock("@/components/ModelConnectionForm", () => ({ ModelConnectionForm: () => null }));
vi.mock("@/components/WorkspaceNameForm", () => ({ WorkspaceNameForm: () => null }));
vi.mock("@/components/WorkspaceReindexPanel", () => ({ WorkspaceReindexPanel: () => null }));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  setWorkspaceLanguage: (id: string, language: string, headers: unknown) =>
    apiFetch(`/workspaces/${id}`, headers, {
      method: "PATCH",
      body: JSON.stringify({ language }),
    }),
}));

const isWorkspaceAdmin = vi.fn();
const refetch = vi.fn();
vi.mock("@/lib/workspace", () => ({
  useIsWorkspaceAdmin: (...args: unknown[]) => isWorkspaceAdmin(...args),
  useWorkspaceName: () => "Acme",
  useWorkspace: () => ({
    refetch,
    memberships: [{ id: "w1", name: "Acme", language: "en" }],
  }),
}));

beforeEach(() => {
  isWorkspaceAdmin.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

// The page unwraps `params` with use(), which suspends until the promise settles.
const page = () => {
  const params = Promise.resolve({ workspaceId: "w1" });
  return act(async () => {
    render(
      <Suspense fallback={null}>
        <WorkspaceSettingsPage params={params} />
      </Suspense>,
    );
  });
};

describe("workspace settings: notification language", () => {
  it("admin changes the notification language", async () => {
    apiFetch.mockResolvedValue({ id: "w1", language: "th" });
    await page();
    const select = await screen.findByLabelText("Language for notifications");
    expect(select).toHaveValue("en");
    await userEvent.selectOptions(select, "ไทย");
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/workspaces/w1",
        { Authorization: "Bearer test" },
        { method: "PATCH", body: JSON.stringify({ language: "th" }) },
      ),
    );
    expect(select).toHaveValue("th");
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("members see the language but cannot change it", async () => {
    isWorkspaceAdmin.mockReturnValue(false);
    await page();
    expect(await screen.findByText("English")).toBeInTheDocument();
    expect(screen.queryByLabelText("Language for notifications")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
