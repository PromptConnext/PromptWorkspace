import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Trigger() {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast({ title: "Moved T001", duration: 5000, action: { label: "Undo", onClick: () => {} } })
      }
    >
      Fire
    </button>
  );
}

function fire() {
  render(
    <ToastProvider>
      <Trigger />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Fire" }));
  return screen.getByText("Moved T001").closest("div[class*='pointer-events-auto']") as HTMLElement;
}

/** Advances the fake clock inside act, so dismissals render. */
function elapse(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("toast auto-dismiss", () => {
  it("dismisses after its duration", () => {
    fire();
    elapse(5000 + 200);
    expect(screen.queryByText("Moved T001")).not.toBeInTheDocument();
  });

  it("pauses while hovered and resumes with the time left", () => {
    const toast = fire();
    elapse(3000);
    fireEvent.mouseEnter(toast);
    elapse(10000);
    expect(screen.getByText("Moved T001")).toBeInTheDocument();

    fireEvent.mouseLeave(toast);
    elapse(1900);
    expect(screen.getByText("Moved T001")).toBeInTheDocument();
    elapse(300);
    expect(screen.queryByText("Moved T001")).not.toBeInTheDocument();
  });

  it("pauses while focus is inside, across its own buttons", () => {
    const toast = fire();
    const undo = screen.getByRole("button", { name: "Undo" });
    const close = screen.getByRole("button", { name: "Dismiss notification" });
    fireEvent.focus(undo);
    // Moving between the toast's own buttons keeps it held.
    fireEvent.blur(undo, { relatedTarget: close });
    fireEvent.focus(close);
    elapse(10000);
    expect(screen.getByText("Moved T001")).toBeInTheDocument();

    fireEvent.blur(close, { relatedTarget: document.body });
    elapse(5000 + 200);
    expect(screen.queryByText("Moved T001")).not.toBeInTheDocument();
    expect(toast).not.toBeInTheDocument();
  });
});
