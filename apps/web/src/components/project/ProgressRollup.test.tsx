import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attributionIsComplete, ProgressRollup, shippedBuilds, shippedTaskIds } from "./ProgressRollup";
import type { DeliveryChange, DeliveryPlan, DeploymentStatus, ProjectGraph } from "@/lib/types";

let mockStatus: DeploymentStatus | null = null;
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({ data: mockStatus, error: null, loading: false }),
}));

let mockPlan: DeliveryPlan | null = null;
vi.mock("./DeliveryOverview", () => ({
  useDeliveryPlanData: () => ({ data: mockPlan, error: null, loading: false }),
}));

afterEach(() => {
  cleanup();
  mockPlan = null;
});

const graph = {
  project: { id: "p1" },
  requirements: [{ id: "r1", title: "Uploads", status: "approved" }],
  spec_documents: [{ id: "s1", requirement_id: "r1" }],
  tasks: [
    { id: "t1", spec_id: "s1", title: "A", status: "implemented" },
    { id: "t2", spec_id: "s1", title: "B", status: "verified" },
    { id: "t3", spec_id: "s1", title: "C", status: "todo" },
  ],
  artifacts: [],
  agent_runs: [],
  discussions: [],
} as unknown as ProjectGraph;

/** A live build row, newest-first ordering supplied by the caller. */
function build(
  id: string,
  url: string,
  taskIds: string[],
  attribution_state: "uncomputed" | "frozen" = "frozen",
) {
  return {
    id,
    state: "live",
    url,
    attribution_state,
    tasks: taskIds.map((t) => ({ id: t, title: t.toUpperCase(), ref: null })),
  };
}

describe("shippedTaskIds", () => {
  it("takes only tasks from builds that actually published", () => {
    const status = {
      recent: [
        { id: "d2", state: "failed", tasks: [{ id: "t9", title: "X", ref: null }] },
        { id: "d1", state: "live", attribution_state: "frozen", tasks: [{ id: "t1", title: "A", ref: null }] },
      ],
    } as unknown as DeploymentStatus;
    expect([...shippedTaskIds(status)]).toEqual(["t1"]);
  });

  it("is empty when nothing has deployed", () => {
    expect(shippedTaskIds(null).size).toBe(0);
  });

  // Plan 0024 M3: a frozen set is a delta, so the cumulative answer is
  // bounded at the build currently being served.
  it("unions every build up to and including the one being served", () => {
    const status = {
      url: "https://v2.test/",
      recent: [build("d2", "https://v2.test/", ["t2"]), build("d1", "https://v1.test/", ["t1"])],
    } as unknown as DeploymentStatus;
    expect([...shippedTaskIds(status)].sort()).toEqual(["t1", "t2"]);
  });

  it("stops at the serving build, so a rolled-back build is not counted", () => {
    // d3 is newer but the preview is back on d2's URL — a rollback. d3's work
    // is NOT in the version you can open, and unioning it over-counted.
    const status = {
      url: "https://v2.test/",
      recent: [
        build("d3", "https://v3.test/", ["t3"]),
        build("d2", "https://v2.test/", ["t2"]),
        build("d1", "https://v1.test/", ["t1"]),
      ],
    } as unknown as DeploymentStatus;
    expect([...shippedTaskIds(status)].sort()).toEqual(["t1", "t2"]);
    expect(shippedBuilds(status).map((b) => b.id)).toEqual(["d2", "d1"]);
  });

  it("falls back to the newest live build when no URL matches", () => {
    const status = {
      url: "https://somewhere-else.test/",
      recent: [build("d2", "https://v2.test/", ["t2"]), build("d1", "https://v1.test/", ["t1"])],
    } as unknown as DeploymentStatus;
    expect(shippedBuilds(status).map((b) => b.id)).toEqual(["d2", "d1"]);
  });
});

describe("attributionIsComplete", () => {
  it("is true when every contributing build was attributed", () => {
    const status = {
      url: "https://v1.test/",
      recent: [build("d1", "https://v1.test/", ["t1"])],
    } as unknown as DeploymentStatus;
    expect(attributionIsComplete(status)).toBe(true);
  });

  it("is false when any contributing build was not", () => {
    const status = {
      url: "https://v2.test/",
      recent: [
        build("d2", "https://v2.test/", ["t2"]),
        build("d1", "https://v1.test/", [], "uncomputed"),
      ],
    } as unknown as DeploymentStatus;
    expect(attributionIsComplete(status)).toBe(false);
  });

  it("ignores an unattributed build that the serving bound excludes", () => {
    const status = {
      url: "https://v2.test/",
      recent: [
        build("d3", "https://v3.test/", [], "uncomputed"),
        build("d2", "https://v2.test/", ["t2"]),
      ],
    } as unknown as DeploymentStatus;
    expect(attributionIsComplete(status)).toBe(true);
  });
});

describe("ProgressRollup", () => {
  it("says how many of the done tasks are in the version you can open", () => {
    mockStatus = {
      url: "https://v1.test/",
      recent: [build("d1", "https://v1.test/", ["t1"])],
    } as unknown as DeploymentStatus;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.getByText(/2\/3 tasks/)).toBeInTheDocument();
    expect(screen.getByText(/1 in the version you can open/)).toBeInTheDocument();
  });

  it("says nothing about builds when the project has never deployed", () => {
    mockStatus = null;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.queryByText(/version you can open/)).not.toBeInTheDocument();
  });

  it("suppresses the count when a contributing build was never attributed", () => {
    mockStatus = {
      url: "https://v1.test/",
      recent: [build("d1", "https://v1.test/", [], "uncomputed")],
    } as unknown as DeploymentStatus;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.getByText(/Not yet recorded/i)).toBeInTheDocument();
    // The suppressed case must not fall through to "0 in the version you can
    // open" — a guess dressed as a measurement. Matched on the leading count,
    // since the suppression copy ends in the same words.
    expect(screen.queryByText(/^\d+ in the version you can open/)).not.toBeInTheDocument();
  });

  it("still reports a frozen zero, which the old shipped.size guard hid", () => {
    mockStatus = {
      url: "https://v1.test/",
      recent: [build("d1", "https://v1.test/", [])],
    } as unknown as DeploymentStatus;
    render(<ProgressRollup graph={graph} projectId="p1" />);
    expect(screen.getByText(/0 in the version you can open/)).toBeInTheDocument();
  });

  describe("with delivery Changes", () => {
    const change = (o: Partial<DeliveryChange>): DeliveryChange => ({
      id: "c", ref: "C1", key: "setup", title: "Setup", kind: "setup", story: null,
      priority: null, position: 0, wave: 0, depends_on: [], task_ids: [], done: 0, total: 0, ...o,
    });
    const changed = {
      ...graph,
      tasks: [
        { id: "t1", spec_id: "s1", title: "A", status: "implemented", change_id: "c1" },
        { id: "t2", spec_id: "s1", title: "B", status: "verified", change_id: "c1" },
        { id: "t3", spec_id: "s1", title: "C", status: "todo", change_id: "c1" },
        { id: "t4", spec_id: "s1", title: "D", status: "in_progress", change_id: "c2" },
        { id: "t5", spec_id: "s1", title: "E", status: "implemented", change_id: null },
      ],
    } as unknown as ProjectGraph;

    it("groups the roll-up by Change, with 'C1 Setup: 2 of 3 done'", () => {
      mockStatus = null;
      mockPlan = {
        plan_approval: "none",
        changes: [
          change({ id: "c1", ref: "C1", title: "Setup" }),
          change({ id: "c2", ref: "C2", title: "Book", kind: "story", position: 1 }),
        ],
      };
      render(<ProgressRollup graph={changed} projectId="p1" />);

      const c1 = screen.getByRole("group", { name: /C1/ });
      expect(c1).toHaveTextContent("Setup");
      expect(c1).toHaveTextContent("2/3 tasks");
      expect(screen.getByRole("group", { name: /C2/ })).toHaveTextContent("0/1 tasks");
      // A task with no Change keeps being counted, in a group of its own.
      expect(screen.getByRole("group", { name: /Not in a change/ })).toHaveTextContent("1/1 tasks");
      // The per-requirement view gives way to the per-Change one.
      expect(screen.queryByText("Uploads")).not.toBeInTheDocument();
    });

    it("keeps the per-requirement roll-up when the project has no Changes", () => {
      mockPlan = { plan_approval: "none", changes: [] };
      render(<ProgressRollup graph={graph} projectId="p1" />);
      expect(screen.getByText("Uploads")).toBeInTheDocument();
      expect(screen.getByText(/2\/3 tasks/)).toBeInTheDocument();
    });
  });
});
