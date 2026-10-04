import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("NewWorkspaceDialog", () => {
  it("renders nothing when closed", () => {
    render(<NewWorkspaceDialog open={false} onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables Create until a name is typed", async () => {
    render(<NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    const create = screen.getByRole("button", { name: /^create$/i });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/workspace name/i), "   ");
    expect(create).toBeDisabled();
  });

  it("submits the trimmed name and closes", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewWorkspaceDialog open onClose={onClose} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/workspace name/i), "  Globex ");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Globex"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the failure in an alert and stays open", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    render(<NewWorkspaceDialog open onClose={onClose} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Globex");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel", async () => {
    const onClose = vi.fn();
    render(<NewWorkspaceDialog open onClose={onClose} onCreate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
