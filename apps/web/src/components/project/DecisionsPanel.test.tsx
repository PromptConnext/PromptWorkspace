import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decision, DecisionsOut } from "@/lib/types";
import { DecisionsPanel } from "./DecisionsPanel";

let decisions: DecisionsOut | null = null;
const refetch = vi.fn();
const mutate = vi.fn();
vi.mock("@/lib/hooks", async () => {
  const { useState } = await import("react");
  return {
    useCloudGet: (path: string | null) => {
      // Like the real hook, a mutate re-renders the component that owns it.
      const [, rerender] = useState(0);
      return {
        data: path?.endsWith("/decisions") ? decisions : [],
        error: null,
        loading: false,
        refetch,
        mutate: (next: unknown) => {
          mutate(next);
          rerender((n) => n + 1);
        },
      };
    },
  };
});
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ authHeaders: () => ({}) }),
}));
const resolveDecision = vi.fn();
vi.mock("@/lib/api", () => ({
  resolveDecision: (...a: unknown[]) => resolveDecision(...a),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const decision = (o: Partial<Decision>): Decision => ({
  id: "d1", project_id: "p1", workspace_id: "w1", kind: "plan_approval",
  title: "Approve the delivery plan", subject_stage: "tasks", subject_hash: "h",
  routed_hat: "tech_steward", status: "open", rationale: null, requested_by: "u1",
  resolved_by: null, created_at: "2026-10-04T08:00:00Z", resolved_at: null,
  can_resolve: true, ...o,
});

describe("DecisionsPanel", () => {
  it("shows both approval states", () => {
    decisions = { decisions: [], states: { intent: "approved", plan: "pending" } };
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);
    expect(screen.getByText("Intent")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.getByText(/No decisions yet/)).toBeInTheDocument();
  });

  it("approves an open decision routed to me and applies the snapshot", async () => {
    decisions = { decisions: [decision({})], states: { intent: "none", plan: "pending" } };
    const snapshot: DecisionsOut = {
      decisions: [decision({ status: "approved", can_resolve: false, resolved_by: "u2" })],
      states: { intent: "none", plan: "approved" },
    };
    mutate.mockImplementation((next: DecisionsOut) => {
      decisions = next;
    });
    resolveDecision.mockResolvedValue({ ...snapshot.decisions[0], snapshot });
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(resolveDecision).toHaveBeenCalledWith("p1", "d1", "approved", null, {});
    expect(mutate).toHaveBeenCalledWith(snapshot);
    expect(refetch).not.toHaveBeenCalled();
    // The plan state card and the row's status both read the snapshot.
    expect(await screen.findAllByText("Approved")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("refetches when an older API sends no snapshot", async () => {
    decisions = { decisions: [decision({})], states: { intent: "none", plan: "pending" } };
    resolveDecision.mockResolvedValue({});
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(refetch).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refetches when the API sends a null snapshot", async () => {
    decisions = { decisions: [decision({})], states: { intent: "none", plan: "pending" } };
    resolveDecision.mockResolvedValue({ snapshot: null });
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(refetch).toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("requires a reason to request changes", async () => {
    decisions = { decisions: [decision({})], states: { intent: "none", plan: "pending" } };
    resolveDecision.mockResolvedValue({});
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);

    const request = screen.getByRole("button", { name: "Request changes" });
    expect(request).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "Split story 2.");
    await userEvent.click(request);

    expect(resolveDecision).toHaveBeenCalledWith("p1", "d1", "rejected", "Split story 2.", {});
  });

  it("does not offer actions on decisions routed to someone else", () => {
    decisions = {
      decisions: [decision({ can_resolve: false })],
      states: { intent: "none", plan: "pending" },
    };
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting on the tech steward/)).toBeInTheDocument();
  });

  it("shows the rationale of a resolved decision", () => {
    decisions = {
      decisions: [decision({ status: "rejected", rationale: "Split story 2.", can_resolve: false })],
      states: { intent: "none", plan: "changes_requested" },
    };
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);
    expect(screen.getByText("Split story 2.")).toBeInTheDocument();
  });

  it("sends a reason typed before approving", async () => {
    decisions = { decisions: [decision({})], states: { intent: "none", plan: "pending" } };
    resolveDecision.mockResolvedValue({});
    render(<DecisionsPanel projectId="p1" workspaceId="w1" />);

    await userEvent.type(screen.getByLabelText("Reason"), "  Looks right.  ");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(resolveDecision).toHaveBeenCalledWith("p1", "d1", "approved", "Looks right.", {});
  });
});
