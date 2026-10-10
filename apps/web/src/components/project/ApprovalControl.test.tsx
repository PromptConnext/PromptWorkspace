import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionsOut } from "@/lib/types";
import { ApprovalControl } from "./ApprovalControl";

let data: DecisionsOut | null = null;
let loadError: string | null = null;
const refetch = vi.fn();
const retry = vi.fn();
const mutate = vi.fn();
// The control reads the shared delivery overview's decisions slice.
vi.mock("./DeliveryOverview", () => ({
  useDecisionsData: () => ({
    data,
    error: loadError,
    loading: data === null && loadError === null,
    refetch,
    retry,
    mutate,
  }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({ Authorization: "Bearer t" }) }),
}));
const requestDecision = vi.fn();
vi.mock("@/lib/api", () => ({
  requestDecision: (...a: unknown[]) => requestDecision(...a),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  loadError = null;
});

const states = (plan: DecisionsOut["states"]["plan"]): DecisionsOut => ({
  decisions: [],
  states: { intent: "none", plan },
});

describe("ApprovalControl", () => {
  it("offers a request when nothing is requested yet", async () => {
    data = states("none");
    const snapshot = states("pending");
    requestDecision.mockResolvedValue({ id: "d1", snapshot });
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);

    expect(screen.getByText("Not requested")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));

    expect(requestDecision).toHaveBeenCalledWith("p1", "plan_approval", { Authorization: "Bearer t" });
    // The response carries the listing after the request: applied, not refetched.
    expect(mutate).toHaveBeenCalledWith(snapshot);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("shows the state from the request's snapshot", async () => {
    // A stand-in for the real hook's mutate: the next render sees the data.
    mutate.mockImplementation((next: DecisionsOut) => {
      data = next;
    });
    data = states("none");
    requestDecision.mockResolvedValue({ id: "d1", snapshot: states("pending") });
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);

    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));

    expect(await screen.findByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides the button while pending or approved", () => {
    data = states("pending");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    data = states("approved");
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks again when the document changed since approval", () => {
    data = states("stale");
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(screen.getByText("Changed since approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request plan approval" })).toBeInTheDocument();
  });

  it("refetches when an older API sends no snapshot", async () => {
    data = states("none");
    requestDecision.mockResolvedValue({ id: "d1" });
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));
    expect(refetch).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refetches when the API sends a null snapshot", async () => {
    data = states("none");
    requestDecision.mockResolvedValue({ id: "d1", snapshot: null });
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));
    expect(refetch).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    data = states("none");
    requestDecision.mockRejectedValue(new Error("delivery_plan_missing"));
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("delivery_plan_missing");
  });

  it("offers nothing to click until the states have loaded", () => {
    data = null;
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Not requested")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows a load error instead of a request button", () => {
    data = null;
    loadError = "Network down";
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Network down");
    expect(screen.queryByText("Not requested")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request/ })).not.toBeInTheDocument();
  });

  it("an error state shows Retry and clicking it refetches", async () => {
    data = null;
    loadError = "Failed to fetch";
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("refetches when the refresh key changes, and not on the first render", () => {
    data = states("approved");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t1" />);
    expect(refetch).not.toHaveBeenCalled();

    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t1" />);
    expect(refetch).not.toHaveBeenCalled();

    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t2" />);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("never refetches on its own when no refresh key is given", () => {
    data = states("approved");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" />);
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" />);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('saving an approved document shows "Changed since approval" before the refetch resolves', () => {
    data = states("approved");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t1" />);
    expect(screen.getByText("Approved")).toBeInTheDocument();

    // The save lands: the refetch is out (the mock never answers), yet the
    // chip must already stop claiming approval.
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t2" />);

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Changed since approval")).toBeInTheDocument();
    expect(screen.queryByText("Approved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request plan approval" })).toBeInTheDocument();
  });

  it("goes back to the server's answer once the refetch lands", () => {
    data = states("approved");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t1" />);
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t2" />);
    expect(screen.getByText("Changed since approval")).toBeInTheDocument();

    data = states("approved"); // a new response: the save did not change what was approved
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t2" />);

    expect(screen.getByText("Approved")).toBeInTheDocument();
  });

  it("does not invent a stale state for a document that was not approved", () => {
    data = states("pending");
    const { rerender } = render(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t1" />);
    rerender(<ApprovalControl projectId="p1" kind="plan_approval" refreshKey="t2" />);
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
  });
});
