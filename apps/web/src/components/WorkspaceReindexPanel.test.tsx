import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceReindexPanel } from "./WorkspaceReindexPanel";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const reindexWorkspace = vi.fn();
vi.mock("@/lib/api", () => ({
  reindexWorkspace: (...args: unknown[]) => reindexWorkspace(...args),
}));

const isWorkspaceAdmin = vi.fn();
vi.mock("@/lib/workspace", () => ({
  useIsWorkspaceAdmin: (...args: unknown[]) => isWorkspaceAdmin(...args),
}));

beforeEach(() => {
  isWorkspaceAdmin.mockReturnValue(true);
});

afterEach(() => {
  // No global auto-cleanup in this repo — see the other component test files.
  cleanup();
  vi.resetAllMocks();
});

describe("WorkspaceReindexPanel", () => {
  it("asks for confirmation before spending on embeddings", async () => {
    render(<WorkspaceReindexPanel workspaceId="w1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex workspace/i }));
    expect(reindexWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText(/one embedding call/i)).toBeInTheDocument();
  });

  it("reports the queued count and project count using the server's numbers", async () => {
    reindexWorkspace.mockResolvedValue({
      enqueued: 142,
      projects_swept: 6,
      projects: [],
    });
    render(<WorkspaceReindexPanel workspaceId="w1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() =>
      expect(screen.getByText(/142 items queued across 6 projects/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a failure without claiming anything was queued", async () => {
    reindexWorkspace.mockRejectedValue(new Error("forbidden"));
    render(<WorkspaceReindexPanel workspaceId="w1" />);
    await userEvent.click(screen.getByRole("button", { name: /reindex workspace/i }));
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    await waitFor(() => expect(screen.getByText("forbidden")).toBeInTheDocument());
    expect(screen.queryByText(/queued/i)).not.toBeInTheDocument();
  });

  it("does not render the control for non-admins", () => {
    isWorkspaceAdmin.mockReturnValue(false);
    render(<WorkspaceReindexPanel workspaceId="w1" />);
    expect(screen.queryByRole("button", { name: /reindex workspace/i })).not.toBeInTheDocument();
  });
});
