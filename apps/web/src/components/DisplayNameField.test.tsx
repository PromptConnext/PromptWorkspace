import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMember } from "@/lib/types";
import { DisplayNameField } from "./DisplayNameField";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ "X-User-Id": "bob" }) }),
}));
const updateMemberDisplayName = vi.fn();
vi.mock("@/lib/api", () => ({
  updateMemberDisplayName: (...a: unknown[]) => updateMemberDisplayName(...a),
}));

const member: WorkspaceMember = {
  workspace_id: "w1",
  user_id: "bob",
  email: "bob@x.com",
  display_name: "Bob",
  role: "member",
  invited_by: null,
  created_at: "2026-10-01T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("DisplayNameField", () => {
  it("prefills the current display name", () => {
    render(<DisplayNameField workspaceId="w1" member={member} label="Your name" />);
    expect(screen.getByLabelText("Your name")).toHaveValue("Bob");
  });

  it("saves the trimmed value once and shows Saved", async () => {
    updateMemberDisplayName.mockResolvedValue({ ...member, display_name: "Somchai" });
    const onSaved = vi.fn();
    render(
      <DisplayNameField workspaceId="w1" member={member} label="Your name" onSaved={onSaved} />,
    );
    const input = screen.getByLabelText("Your name");
    await userEvent.clear(input);
    await userEvent.type(input, "  Somchai  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect(updateMemberDisplayName).toHaveBeenCalledTimes(1);
    expect(updateMemberDisplayName).toHaveBeenCalledWith(
      "w1",
      "bob",
      "Somchai",
      { "X-User-Id": "bob" },
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("sends null for a blank value", async () => {
    updateMemberDisplayName.mockResolvedValue({ ...member, display_name: null });
    render(<DisplayNameField workspaceId="w1" member={member} label="Your name" />);
    await userEvent.clear(screen.getByLabelText("Your name"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateMemberDisplayName).toHaveBeenCalled());
    expect(updateMemberDisplayName.mock.calls[0][2]).toBeNull();
  });

  it("keeps showing Saved when the member prop changes after a save", async () => {
    updateMemberDisplayName.mockResolvedValue({ ...member, display_name: "Somchai" });
    const { rerender } = render(
      <DisplayNameField workspaceId="w1" member={member} label="Your name" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    rerender(
      <DisplayNameField
        workspaceId="w1"
        member={{ ...member, display_name: "Somchai" }}
        label="Your name"
      />,
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});
