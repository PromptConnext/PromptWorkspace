import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryChange, DeliveryPlan as Plan, ProjectGraph } from "@/lib/types";
import { DeliveryPlan, groupByWave } from "./DeliveryPlan";

let plan: Plan | null = null;
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({ data: plan, error: null, loading: false, refetch: vi.fn() }),
}));
vi.mock("./ApprovalControl", () => ({
  ApprovalControl: () => <div>approval-control</div>,
}));
afterEach(cleanup);

const change = (o: Partial<DeliveryChange>): DeliveryChange => ({
  id: "c", ref: "C1", key: "setup", title: "Setup", kind: "setup", story: null,
  priority: null, position: 0, wave: 0, depends_on: [], task_ids: [], ...o,
});

const graph = {
  tasks: [
    { id: "t1", feature_tag: "T001", title: "Create the project", change_id: "c1" },
    { id: "t2", feature_tag: "T002 [P]", title: "Booking", change_id: "c2" },
  ],
} as unknown as ProjectGraph;

describe("groupByWave", () => {
  it("groups by wave in order", () => {
    const waves = groupByWave([
      change({ id: "a", wave: 1 }), change({ id: "b", wave: 0 }), change({ id: "c", wave: 1 }),
    ]);
    expect(waves.map((w) => w.map((c) => c.id))).toEqual([["b"], ["a", "c"]]);
  });
});

describe("DeliveryPlan", () => {
  it("explains what to do when there is no plan yet", () => {
    plan = { changes: [], plan_approval: "none" };
    render(<DeliveryPlan graph={{ tasks: [] } as unknown as ProjectGraph} projectId="p1" />);
    expect(screen.getByText(/Generate tasks in the Planner/)).toBeInTheDocument();
  });

  it("asks for a re-save when tasks exist from before changes were grouped", () => {
    plan = { changes: [], plan_approval: "none" };
    render(<DeliveryPlan graph={graph} projectId="p1" />);
    expect(
      screen.getByText(
        "Save the tasks document again in the Planner to group these tasks into Changes.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Generate tasks in the Planner/)).not.toBeInTheDocument();
  });

  it("lays changes out in waves with their tasks and dependencies", () => {
    plan = {
      plan_approval: "none",
      changes: [
        change({ id: "c1", ref: "C1", task_ids: ["t1"] }),
        change({ id: "c2", ref: "C2", key: "story:1", kind: "story", title: "User Story 1 - Book",
                 priority: "P1", wave: 1, depends_on: ["C1"], task_ids: ["t2"] }),
      ],
    };
    render(<DeliveryPlan graph={graph} projectId="p1" />);

    const first = screen.getByRole("region", { name: "Wave 1" });
    expect(within(first).getByText("C1")).toBeInTheDocument();
    expect(within(first).getByText("T001")).toBeInTheDocument();
    const second = screen.getByRole("region", { name: "Wave 2" });
    expect(within(second).getByText("User Story 1 - Book")).toBeInTheDocument();
    expect(within(second).getByText("P1")).toBeInTheDocument();
    expect(within(second).getByText("After C1")).toBeInTheDocument();
    expect(screen.getByText("approval-control")).toBeInTheDocument();
  });
});
