import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Decision, DeliveryOverview, ProjectGraph } from "@/lib/types";
import { DecisionsPanel } from "./DecisionsPanel";
import { DeliveryOverviewProvider } from "./DeliveryOverview";
import { DeliveryPlan } from "./DeliveryPlan";

// The real hook and components; only the network is a stand-in. Every GET
// goes through apiFetch, so its calls are the requests the page makes.
const apiFetch = vi.fn();
const requestDecision = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  requestDecision: (...a: unknown[]) => requestDecision(...a),
  resolveDecision: vi.fn(),
}));
// Stable references: useCloudGet refetches when `user` changes identity.
const auth = { user: { id: "u1" }, authHeaders: () => ({}) };
vi.mock("@/lib/auth", () => ({ useAuth: () => auth }));

const decision = (o: Partial<Decision>): Decision => ({
  id: "d1", project_id: "p1", workspace_id: "w1", kind: "intent_approval",
  title: "Approve the intent", subject_stage: "specify", subject_hash: "h",
  subject_content: "# Spec", routed_hat: "business_owner", status: "approved",
  rationale: null, requested_by: "u1", resolved_by: "u1",
  created_at: "2026-10-04T08:00:00Z", resolved_at: "2026-10-04T09:00:00Z",
  can_resolve: false, is_current: true, ...o,
});

const overview = (): DeliveryOverview => ({
  plan: {
    plan_approval: "none",
    changes: [
      {
        id: "c1", ref: "C1", key: "setup", title: "Setup", kind: "setup", story: null,
        priority: null, position: 0, wave: 0, depends_on: [], task_ids: ["t1"],
      },
    ],
  },
  decisions: [decision({})],
  states: { intent: "approved", plan: "none" },
  roles: [
    { hat: "business_owner", user_id: "u1" },
    { hat: "tech_steward", user_id: null },
  ],
});

const graph = {
  tasks: [{ id: "t1", feature_tag: "T001", title: "Create the project", change_id: "c1" }],
} as unknown as ProjectGraph;

const paths = () => apiFetch.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve(path.endsWith("/members") ? [] : overview()),
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("DeliveryOverviewProvider", () => {
  it("opening Delivery makes one request, not three", async () => {
    render(
      <DeliveryOverviewProvider projectId="p1">
        <DeliveryPlan graph={graph} projectId="p1" />
      </DeliveryOverviewProvider>,
    );

    // The plan and its approval control both come from the one answer.
    expect(await screen.findByText("Create the project")).toBeInTheDocument();
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    expect(paths()).toEqual(["/projects/p1/delivery-overview"]);
  });

  it("the Decisions tab reads the same one request", async () => {
    render(
      <DeliveryOverviewProvider projectId="p1">
        <DecisionsPanel workspaceId="w1" />
      </DeliveryOverviewProvider>,
    );

    expect(await screen.findByText("Approve the intent")).toBeInTheDocument();
    // The members list is the workspace's, not a delivery read.
    expect(paths().filter((p) => !p.endsWith("/members"))).toEqual([
      "/projects/p1/delivery-overview",
    ]);
  });

  it("asks for nothing until a delivery surface mounts", () => {
    render(
      <DeliveryOverviewProvider projectId="p1">
        <p>a Planner step with no approval control</p>
      </DeliveryOverviewProvider>,
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("a request's snapshot updates every surface without a refetch", async () => {
    requestDecision.mockResolvedValue({
      ...decision({ id: "d2", kind: "plan_approval", status: "open" }),
      snapshot: {
        decisions: [
          decision({ id: "d2", kind: "plan_approval", title: "Approve the delivery plan",
                     subject_stage: "tasks", status: "open", resolved_by: null,
                     resolved_at: null }),
          decision({}),
        ],
        states: { intent: "approved", plan: "pending" },
      },
    });
    render(
      <DeliveryOverviewProvider projectId="p1">
        <DeliveryPlan graph={graph} projectId="p1" />
        <DecisionsPanel workspaceId="w1" />
      </DeliveryOverviewProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Request plan approval" }));

    // The plan's control and the Decisions list both show the new request.
    expect(await screen.findAllByText("Waiting for approval")).toHaveLength(2);
    expect(screen.getByText("Approve the delivery plan")).toBeInTheDocument();
    expect(paths().filter((p) => !p.endsWith("/members"))).toEqual([
      "/projects/p1/delivery-overview",
    ]);
  });
});
