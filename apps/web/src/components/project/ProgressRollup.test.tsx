import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressRollup, shippedTaskIds } from "./ProgressRollup";
import type { DeploymentStatus, ProjectGraph } from "@/lib/types";

let mockStatus: DeploymentStatus | null = null;
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({ data: mockStatus, error: null, loading: false }),
}));

afterEach(cleanup);

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

describe("shippedTaskIds", () => {
  it("takes only tasks from builds that actually published", () => {
    const status = {
      recent: [
        { id: "d2", state: "failed", tasks: [{ id: "t9", title: "X", ref: null }] },
        { id: "d1", state: "live", tasks: [{ id: "t1", title: "A", ref: null }] },
      ],
    } as unknown as DeploymentStatus;
    expect([...shippedTaskIds(status)]).toEqual(["t1"]);
  });

  it("is empty when nothing has deployed", () => {
    expect(shippedTaskIds(null).size).toBe(0);
  });
});

describe("ProgressRollup", () => {
  it("says how many of the done tasks are in the version you can open", () => {
    mockStatus = {
      recent: [{ id: "d1", state: "live", tasks: [{ id: "t1", title: "A", ref: null }] }],
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
});
