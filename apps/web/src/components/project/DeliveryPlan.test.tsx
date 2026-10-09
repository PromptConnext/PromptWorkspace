import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryChange, DeliveryPlan as Plan, ProjectGraph } from "@/lib/types";
import { DeliveryPlan, groupByWave } from "./DeliveryPlan";

let plan: Plan | null = null;
let loading = false;
let loadError: string | null = null;
const retry = vi.fn();
vi.mock("./DeliveryOverview", () => ({
  useDeliveryPlanData: () => ({ data: plan, error: loadError, loading, refetch: vi.fn(), retry }),
}));
vi.mock("./ApprovalControl", () => ({
  ApprovalControl: () => <div>approval-control</div>,
}));
afterEach(() => {
  cleanup();
  plan = null;
  loading = false;
  loadError = null;
});

const change = (o: Partial<DeliveryChange>): DeliveryChange => ({
  id: "c", ref: "C1", key: "setup", title: "Setup", kind: "setup", story: null,
  priority: null, position: 0, wave: 0, depends_on: [], task_ids: [], done: 0, total: 0, ...o,
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
  it("says the plan is loading instead of rendering nothing", () => {
    plan = null;
    loading = true;
    render(<DeliveryPlan graph={graph} projectId="p1" />);
    expect(screen.getByText("Loading delivery plan…")).toBeInTheDocument();
  });

  it("shows the load error rather than the loading line", () => {
    plan = null;
    loadError = "Network down";
    render(<DeliveryPlan graph={graph} projectId="p1" />);
    expect(screen.getByText("Network down")).toBeInTheDocument();
    expect(screen.queryByText("Loading delivery plan…")).not.toBeInTheDocument();
  });

  it("an error state shows Retry and clicking it refetches", async () => {
    plan = null;
    loadError = "Failed to fetch";
    render(<DeliveryPlan graph={graph} projectId="p1" />);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("lists a change's tasks by task number, not graph order, with unnumbered ones last", () => {
    plan = {
      plan_approval: "none",
      changes: [change({ id: "c1", task_ids: ["a", "b", "c", "d", "e"] })],
    };
    const g = {
      tasks: [
        { id: "a", feature_tag: "T011", title: "Eleven", change_id: "c1" },
        { id: "b", feature_tag: null, title: "No ref one", change_id: "c1" },
        { id: "c", feature_tag: "T010 [P]", title: "Ten", change_id: "c1" },
        { id: "d", feature_tag: "T002", title: "Two", change_id: "c1" },
        { id: "e", feature_tag: "", title: "No ref two", change_id: "c1" },
      ],
    } as unknown as ProjectGraph;
    render(<DeliveryPlan graph={g} projectId="p1" />);
    const titles = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(titles).toEqual(["T002Two", "T010Ten", "T011Eleven", "No ref one", "No ref two"]);
  });

  it("shows the plan before the graph arrives, and the task titles once it does", () => {
    plan = { plan_approval: "none", changes: [change({ id: "c1", ref: "C1", task_ids: ["t1"] })] };
    const { rerender } = render(<DeliveryPlan graph={null} projectId="p1" />);

    expect(screen.getByText("C1")).toBeInTheDocument();
    expect(screen.getByText("approval-control")).toBeInTheDocument();
    expect(screen.getByText(/1 task · loading titles/)).toBeInTheDocument();

    rerender(<DeliveryPlan graph={graph} projectId="p1" />);
    expect(screen.getByText("Create the project")).toBeInTheDocument();
    expect(screen.queryByText(/loading titles/)).not.toBeInTheDocument();
  });

  it("an empty plan waits for the graph before saying what to do", () => {
    plan = { changes: [], plan_approval: "none" };
    render(<DeliveryPlan graph={null} projectId="p1" />);
    expect(screen.getByText("Loading delivery plan…")).toBeInTheDocument();
  });

  it("an empty plan stops waiting when the graph failed to load", () => {
    plan = { changes: [], plan_approval: "none" };
    render(<DeliveryPlan graph={null} graphError="Failed to fetch" projectId="p1" />);
    expect(screen.queryByText("Loading delivery plan…")).not.toBeInTheDocument();
    expect(screen.getByText(/Generate tasks in the Planner/)).toBeInTheDocument();
  });

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

  it("shows how many of a change's tasks are done, with an accessible progress bar", () => {
    plan = {
      plan_approval: "none",
      changes: [
        change({ id: "c1", ref: "C1", task_ids: ["a", "b", "c"], done: 2, total: 3 }),
        change({ id: "c2", ref: "C2", key: "story:1", kind: "story", wave: 1, task_ids: ["d"],
                 done: 0, total: 1 }),
      ],
    };
    render(<DeliveryPlan graph={null} projectId="p1" />);

    expect(screen.getByText("2/3 done")).toBeInTheDocument();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute("aria-valuenow", "2");
    expect(bars[0]).toHaveAttribute("aria-valuemin", "0");
    expect(bars[0]).toHaveAttribute("aria-valuemax", "3");
    expect(bars[0]).toHaveAccessibleName(/C1/);
    expect(bars[1]).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows no progress for a change that carries no tasks", () => {
    plan = { plan_approval: "none", changes: [change({ id: "c1", ref: "C1" })] };
    render(<DeliveryPlan graph={null} projectId="p1" />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/done$/)).not.toBeInTheDocument();
  });
});
