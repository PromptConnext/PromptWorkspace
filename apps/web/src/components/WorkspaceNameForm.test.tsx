import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceNameForm } from "./WorkspaceNameForm";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer test" }) }),
}));

const renameWorkspace = vi.fn();
vi.mock("@/lib/api", () => ({
  renameWorkspace: (...args: unknown[]) => renameWorkspace(...args),
}));

const isWorkspaceAdmin = vi.fn();
const refetch = vi.fn();
let workspaceName = "Acme";
vi.mock("@/lib/workspace", () => ({
  useIsWorkspaceAdmin: (...args: unknown[]) => isWorkspaceAdmin(...args),
  useWorkspaceName: () => workspaceName,
  useWorkspace: () => ({ refetch }),
}));

beforeEach(() => {
  isWorkspaceAdmin.mockReturnValue(true);
  workspaceName = "Acme";
});

afterEach(() => {
  // No global auto-cleanup in this repo — see the other component test files.
  cleanup();
  vi.resetAllMocks();
});

describe("WorkspaceNameForm", () => {
  it("prefills the current name and disables Save while it is unchanged", () => {
    render(<WorkspaceNameForm workspaceId="w1" />);
    expect(screen.getByLabelText(/workspace name/i)).toHaveValue("Acme");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("disables Save for a blank name and for whitespace-only edits of the same name", async () => {
    render(<WorkspaceNameForm workspaceId="w1" />);
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    await userEvent.type(input, "  Acme  ");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("saves the trimmed name and refreshes the workspace roster", async () => {
    renameWorkspace.mockResolvedValue({ id: "w1", name: "Globex" });
    render(<WorkspaceNameForm workspaceId="w1" />);
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "  Globex ");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(renameWorkspace).toHaveBeenCalledWith("w1", "Globex", {
        Authorization: "Bearer test",
      }),
    );
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps Save disabled after a successful save and confirms with a status", async () => {
    renameWorkspace.mockResolvedValue({ id: "w1", name: "Globex" });
    render(<WorkspaceNameForm workspaceId="w1" />);
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Globex");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    // The roster has not refetched here (refetch is a mock), so the current
    // name is still "Acme": only the last-saved guard keeps Save disabled.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(renameWorkspace).toHaveBeenCalledTimes(1);
    // Editing again re-enables Save and clears the confirmation.
    await userEvent.type(input, "!");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("allows renaming back to a saved name after another admin renames it", async () => {
    renameWorkspace.mockResolvedValue({ id: "w1", name: "Globex" });
    const { rerender } = render(<WorkspaceNameForm workspaceId="w1" />);
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Globex");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved"));
    // The roster refetch lands with our name, then another admin renames it.
    workspaceName = "Globex";
    rerender(<WorkspaceNameForm workspaceId="w1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    workspaceName = "Initech";
    rerender(<WorkspaceNameForm workspaceId="w1" />);
    expect(input).toHaveValue("Initech");
    await userEvent.clear(input);
    await userEvent.type(input, "Globex");
    expect(screen.getByRole("button", { name: /^save$/i })).toBeEnabled();
  });

  it("shows the server error in an alert and does not refresh", async () => {
    renameWorkspace.mockRejectedValue(new Error("admin_required"));
    render(<WorkspaceNameForm workspaceId="w1" />);
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Globex");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only a workspace admin can rename this workspace.",
    );
    expect(refetch).not.toHaveBeenCalled();
  });

  it("caps the input length", () => {
    render(<WorkspaceNameForm workspaceId="w1" />);
    expect(screen.getByLabelText(/workspace name/i)).toHaveAttribute("maxlength", "100");
  });

  it("shows the name read-only to members", () => {
    isWorkspaceAdmin.mockReturnValue(false);
    render(<WorkspaceNameForm workspaceId="w1" />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();
  });
});
