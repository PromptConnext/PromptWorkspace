import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRolesPanel } from "./ProjectRolesPanel";

const refetch = vi.fn();
const ROLES = [
  { hat: "business_owner", user_id: null },
  { hat: "tech_steward", user_id: "u2" },
];
const MEMBERS = [
  { workspace_id: "w1", user_id: "u1", email: "ploy@x.com", role: "admin", invited_by: null, created_at: "" },
  { workspace_id: "w1", user_id: "u2", email: "arun@x.com", role: "member", invited_by: null, created_at: "" },
];
type Slot = { data: unknown; error: string | null; loading: boolean };
let rolesState: Slot;
let membersState: Slot;
vi.mock("@/lib/hooks", () => ({
  useCloudGet: (path: string) => ({
    ...(path.endsWith("/roles") ? rolesState : membersState),
    refetch,
  }),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ authHeaders: () => ({}) }) }));
const setProjectRole = vi.fn();
vi.mock("@/lib/api", () => ({ setProjectRole: (...a: unknown[]) => setProjectRole(...a) }));
beforeEach(() => {
  rolesState = { data: ROLES, error: null, loading: false };
  membersState = { data: MEMBERS, error: null, loading: false };
});
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
    expect(setProjectRole).not.toHaveBeenCalled();
  });

  it("shows an alert and does not refetch when the update fails", async () => {
    setProjectRole.mockRejectedValue(new Error("Only admins can assign roles"));
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    await userEvent.selectOptions(screen.getByLabelText("Business owner"), "u1");

    expect(await screen.findByRole("alert")).toHaveTextContent("Only admins can assign roles");
    expect(refetch).not.toHaveBeenCalled();
  });

  it("clears the error on the next attempt", async () => {
    setProjectRole.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    await userEvent.selectOptions(screen.getByLabelText("Business owner"), "u1");
    await screen.findByRole("alert");
    await userEvent.selectOptions(screen.getByLabelText("Business owner"), "u1");
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("disables the selects while an update is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    setProjectRole.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    await userEvent.selectOptions(screen.getByLabelText("Business owner"), "u1");
    expect(screen.getByLabelText("Tech steward")).toBeDisabled();
    resolve([]);
    await waitFor(() => expect(screen.getByLabelText("Tech steward")).toBeEnabled());
  });

  it("shows loading and no selects until roles and members are both loaded", () => {
    membersState = { data: null, error: null, loading: true };
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tech steward")).not.toBeInTheDocument();
  });

  it("shows an alert and no selects when members fail to load", () => {
    membersState = { data: null, error: "members unavailable", loading: false };
    render(<ProjectRolesPanel projectId="p1" workspaceId="w1" isAdmin />);
    expect(screen.getByRole("alert")).toHaveTextContent("members unavailable");
    expect(screen.queryByLabelText("Tech steward")).not.toBeInTheDocument();
  });
});
