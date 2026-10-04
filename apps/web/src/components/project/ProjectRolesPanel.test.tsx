import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRolesPanel } from "./ProjectRolesPanel";

const refetch = vi.fn();
vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => ({
    data: path.endsWith("/roles")
      ? [
          { hat: "business_owner", user_id: null },
          { hat: "tech_steward", user_id: "u2" },
        ]
      : [
          { workspace_id: "w1", user_id: "u1", email: "ploy@x.com", role: "admin", invited_by: null, created_at: "" },
          { workspace_id: "w1", user_id: "u2", email: "arun@x.com", role: "member", invited_by: null, created_at: "" },
        ],
    error: null,
    loading: false,
    refetch,
  }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ authHeaders: () => ({}) }) }));
const setProjectRole = vi.fn();
vi.mock("@/lib/api", () => ({ setProjectRole: (...a: unknown[]) => setProjectRole(...a) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ProjectRolesPanel", () => {
  it("shows current holders and lets an admin assign one", async () => {
    setProjectRole.mockResolvedValue([]);
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);

    expect(screen.getByLabelText("Tech steward")).toHaveValue("u2");
    expect(screen.getByLabelText("Business owner")).toHaveValue("");
    await userEvent.selectOptions(screen.getByLabelText("Business owner"), "u1");

    expect(setProjectRole).toHaveBeenCalledWith("p1", "business_owner", "u1", {});
    expect(refetch).toHaveBeenCalled();
  });

  it("clears a hat with the empty option", async () => {
    setProjectRole.mockResolvedValue([]);
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    await userEvent.selectOptions(screen.getByLabelText("Tech steward"), "");
    expect(setProjectRole).toHaveBeenCalledWith("p1", "tech_steward", null, {});
  });

  it("is read-only for members", () => {
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin={false} />);
    expect(screen.getByLabelText("Tech steward")).toBeDisabled();
  });
});
