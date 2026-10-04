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

  it("labels the dialog by its visible title", () => {
    render(<NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAccessibleName("New workspace");
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("focuses the name input when it opens", async () => {
    render(<NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText(/workspace name/i)).toHaveFocus());
  });

  it("closes on Escape when idle", async () => {
    const onClose = vi.fn();
    render(<NewWorkspaceDialog open onClose={onClose} onCreate={vi.fn()} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores Escape and disables Cancel while a create is in flight", async () => {
    const onClose = vi.fn();
    const onCreate = vi.fn(() => new Promise<void>(() => {}));
    render(<NewWorkspaceDialog open onClose={onClose} onCreate={onCreate} />);
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Globex");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(await screen.findByRole("button", { name: /creating/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    render(
      <>
        <button>outside</button>
        <NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );
    const input = screen.getByLabelText(/workspace name/i);
    await userEvent.type(input, "Globex");
    const create = screen.getByRole("button", { name: /^create$/i });
    create.focus();
    await userEvent.tab();
    expect(input).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(create).toHaveFocus();
  });

  it("keeps Tab inside the dialog after focus has left it", async () => {
    render(
      <>
        <button>outside</button>
        <NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} />
      </>,
    );
    const input = screen.getByLabelText(/workspace name/i);
    await waitFor(() => expect(input).toHaveFocus());
    // A click on the backdrop leaves focus on the page body.
    input.blur();
    await userEvent.tab();
    expect(input).toHaveFocus();
  });

  it("returns focus to the opener when it closes", async () => {
    const opener = { current: null as HTMLButtonElement | null };
    function Harness() {
      return (
        <>
          <button ref={(el) => { opener.current = el; }}>opener</button>
          <NewWorkspaceDialog open onClose={vi.fn()} onCreate={vi.fn()} returnFocusRef={opener} />
        </>
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: "opener" })).toHaveFocus());
  });
});
