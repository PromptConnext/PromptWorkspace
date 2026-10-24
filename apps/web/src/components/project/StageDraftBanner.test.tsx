import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageDraftBanner } from "./StageDraftBanner";
import type { StageDraftOut } from "@/lib/types";

function draft(overrides: Partial<StageDraftOut> = {}): StageDraftOut {
  return {
    id: "d1",
    project_id: "p1",
    stage: "plan",
    markdown: "# Plan\n\nAdd a billing module.",
    source: "claude-code",
    model: "claude-opus",
    status: "pending",
    stale: false,
    rejection_note: null,
    last_error: null,
    created_by: "u1",
    created_at: "2026-10-24T00:00:00Z",
    warnings: [],
    ...overrides,
  };
}

function renderBanner(props: Partial<Parameters<typeof StageDraftBanner>[0]> = {}) {
  const onAccept = vi.fn(async () => undefined);
  const onReject = vi.fn(async (_note: string) => undefined);
  render(
    <StageDraftBanner
      draft={draft()}
      canAct
      onAccept={onAccept}
      onReject={onReject}
      {...props}
    />,
  );
  return { onAccept, onReject };
}

describe("StageDraftBanner", () => {
  afterEach(cleanup);

  it("loads the draft into view with source, model and a stale badge", () => {
    renderBanner({ draft: draft({ stale: true, last_error: "graph_write_failed" }) });

    expect(screen.getByText("Draft from your coding agent")).toBeInTheDocument();
    expect(screen.getByText("claude-code · claude-opus")).toBeInTheDocument();
    expect(
      screen.getByText("Stale: written before the previous step changed"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Add a billing module\./)).toBeInTheDocument();
    expect(screen.getByText("Could not apply: graph_write_failed")).toBeInTheDocument();
    cleanup();

    renderBanner({ draft: draft({ model: null }) });
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.queryByText(/Stale:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not apply/)).not.toBeInTheDocument();
  });

  it("accepts, and disables Accept when blockedBy is set", async () => {
    const { onAccept } = renderBanner();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    cleanup();

    const blocked = renderBanner({ blockedBy: "Waiting on 1 · Specify — generate it first." });
    expect(screen.getByText("Waiting on 1 · Specify — generate it first.")).toBeInTheDocument();
    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    fireEvent.click(accept);
    expect(blocked.onAccept).not.toHaveBeenCalled();
  });

  it("asks for a note before rejecting", async () => {
    const { onReject } = renderBanner();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).not.toHaveBeenCalled();
    const note = screen.getByPlaceholderText("Why this draft is rejected");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    fireEvent.change(note, { target: { value: "Wrong framework" } });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onReject).toHaveBeenCalledWith("Wrong framework"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument(),
    );
  });

  it("keeps the note when the reject fails", async () => {
    const onReject = vi.fn(async (_note: string) => {
      throw new Error("draft_not_found");
    });
    renderBanner({ onReject });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.change(screen.getByPlaceholderText("Why this draft is rejected"), {
      target: { value: "Wrong framework" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(onReject).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled());
    expect(screen.getByPlaceholderText("Why this draft is rejected")).toHaveValue(
      "Wrong framework",
    );
  });

  it("shows the rejection note, and no buttons, on a rejected draft", () => {
    renderBanner({ draft: draft({ status: "rejected", rejection_note: "Wrong framework" }) });
    expect(screen.getByText("Rejected: Wrong framework")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
  });

  it("does not promise a Tech Lead review of a draft already rejected", () => {
    renderBanner({ canAct: false, draft: draft({ status: "rejected", rejection_note: "No" }) });
    expect(screen.getByText("Rejected: No")).toBeInTheDocument();
    expect(screen.queryByText("Your Tech Lead reviews this draft.")).not.toBeInTheDocument();
  });

  it("shows a member no buttons on an admin-only stage", () => {
    renderBanner({ canAct: false });
    expect(screen.getByText("Draft from your coding agent")).toBeInTheDocument();
    expect(screen.getByText("Your Tech Lead reviews this draft.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });
});
