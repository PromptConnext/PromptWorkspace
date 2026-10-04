import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionsOut } from "@/lib/types";
import { ApprovalControl } from "./ApprovalControl";

let data: DecisionsOut | null = null;
let loadError: string | null = null;
const refetch = vi.fn();
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({ data, error: loadError, loading: data === null && loadError === null, refetch }),
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
    requestDecision.mockResolvedValue({ id: "d1" });
    render(<ApprovalControl projectId="p1" kind="plan_approval" />);

    expect(screen.getByText("Not requested")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request plan approval" }));

    expect(requestDecision).toHaveBeenCalledWith("p1", "plan_approval", { Authorization: "Bearer t" });
    expect(refetch).toHaveBeenCalled();
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
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
