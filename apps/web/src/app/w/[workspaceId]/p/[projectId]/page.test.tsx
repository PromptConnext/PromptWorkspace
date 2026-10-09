import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectPage from "./page";

const replace = vi.fn();
let search = "";
let refreshError: string | null = null;
let graphLoaded = true;
// A reload of a graph already on screen (after a save in the Planner).
let graphReloading = false;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/w/w1/p/p1",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, use: () => ({ workspaceId: "w1", projectId: "p1" }) };
});
vi.mock("@/components/RequireAuth", () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/TopBar", () => ({
  TopBar: ({ crumbs }: { crumbs: { label: string; loading?: boolean }[] }) => (
    <nav aria-label="crumbs">{crumbs.map((c) => (c.loading ? "[skeleton]" : c.label)).join(" / ")}</nav>
  ),
}));
vi.mock("@/components/PresenceBar", () => ({ PresenceBar: () => null }));
vi.mock("@/lib/workspace", () => ({ useWorkspaceName: () => "WS" }));
vi.mock("@/components/project/GraphBrowser", () => ({
  GraphBrowser: () => <div>graph-view</div>,
}));
vi.mock("@/components/project/Planner", () => ({
  Planner: ({
    step,
    onStepChange,
  }: {
    step?: string | null;
    onStepChange?: (key: string) => void;
  }) => (
    <div>
      planner-view step={step ?? "none"}
      <button type="button" onClick={() => onStepChange?.("plan")}>
        open plan step
      </button>
    </div>
  ),
}));
vi.mock("@/components/project/DecisionsPanel", () => ({
  DecisionsPanel: () => <div>decisions-view</div>,
}));
vi.mock("@/components/project/DeliveryPlan", () => ({
  DeliveryPlan: () => <div>delivery-view</div>,
}));
vi.mock("@/components/project/PreviewPanel", () => ({
  PreviewPanel: () => null,
}));
vi.mock("@/components/project/TaskBoard", () => ({
  TaskBoard: () => <div>board-view</div>,
}));
vi.mock("@/components/project/ProgressRollup", () => ({
  ProgressRollup: () => null,
}));
vi.mock("@/components/project/DiscussionThread", () => ({
  DiscussionThread: () => null,
}));
vi.mock("@/lib/hooks", () => ({
  useCloudGet: () => ({
    data: graphLoaded ? { project: { name: "P" } } : null,
    error: null,
    loading: !graphLoaded || graphReloading,
    refetch: vi.fn(),
    refreshing: false,
    refreshError,
    lastUpdated: Date.now(),
    revalidate: vi.fn(),
  }),
}));

beforeEach(() => {
  replace.mockReset();
  search = "";
  refreshError = null;
  graphLoaded = true;
  graphReloading = false;
});
afterEach(cleanup);

describe("project page tab URL sync", () => {
  it("defaults to Planner and treats unknown slugs as Planner", () => {
    search = "tab=bogus";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByRole("tab", { name: "Planner" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText(/planner-view/)).toBeInTheDocument();
  });

  it("reads the tab from the URL and widens main on Tasks", () => {
    search = "tab=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByText("board-view")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveClass("max-w-none");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("clicking a tab replaces the URL and preserves other params", () => {
    search = "foo=bar";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(replace).toHaveBeenCalledWith("/w/w1/p/p1?foo=bar&tab=graph", {
      scroll: false,
    });
  });

  it("arrow keys and End move between tabs", () => {
    search = "tab=planner";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "ArrowRight",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=delivery", {
      scroll: false,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "ArrowLeft",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=preview", {
      scroll: false,
    });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Planner" }), {
      key: "End",
    });
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=preview", {
      scroll: false,
    });
  });

  it("drops the open task when leaving Tasks, and keeps it on Tasks", () => {
    search = "tab=tasks&task=t1";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=graph", {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=tasks&task=t1", {
      scroll: false,
    });
  });
});

describe("planner step URL sync", () => {
  it("hands the Planner the step in the URL and keeps the step it opens there", () => {
    search = "tab=planner&step=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByText("planner-view step=tasks", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open plan step" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=planner&step=plan", {
      scroll: false,
    });
  });

  it("drops the step when leaving the Planner", () => {
    search = "tab=planner&step=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(replace).toHaveBeenLastCalledWith("/w/w1/p/p1?tab=graph", { scroll: false });
  });
});

describe("a graph reload after a change", () => {
  function renderTab(tab: string) {
    graphReloading = true;
    search = `tab=${tab}`;
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
  }

  it("says Updating… over the old tasks instead of showing them silently", () => {
    // Finding #27: pre-edit task titles painted as if current.
    renderTab("delivery");
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByText("delivery-view")).toBeInTheDocument();
  });

  it("says Updating… in the board's freshness line on Tasks", () => {
    renderTab("tasks");
    expect(screen.getByText("Updating…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByText("board-view")).toBeInTheDocument();
  });

  it("says nothing once the reload is done", () => {
    search = "tab=delivery";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.queryByText("Updating…")).not.toBeInTheDocument();
  });
});

describe("board freshness", () => {
  function renderTasks() {
    search = "tab=tasks";
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
  }

  it("does not put the ticking 'Updated' label in a live region", () => {
    renderTasks();
    const label = screen.getByText(/^Updated /);
    expect(label.closest("[aria-live]")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces a failed refresh through a status region", () => {
    refreshError = "boom";
    renderTasks();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't refresh — showing last loaded data.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("first load", () => {
  function renderLoading(tab: string) {
    graphLoaded = false;
    search = `tab=${tab}`;
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
  }

  it("shows the board skeleton on Tasks, busy and announced", () => {
    renderLoading("tasks");
    expect(screen.getByRole("status")).toHaveTextContent("Loading project…");
    expect(screen.getByRole("status").closest("[aria-busy='true']")).not.toBeNull();
    // The board's own column shells, not a line of text.
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.queryByText(/Loading graph/)).not.toBeInTheDocument();
    expect(screen.queryByText("board-view")).not.toBeInTheDocument();
  });

  it("shows a generic skeleton on other tabs", () => {
    renderLoading("planner");
    expect(screen.getByRole("status")).toHaveTextContent("Loading project…");
    expect(screen.queryByText("In Progress")).not.toBeInTheDocument();
  });

  it("opens Delivery and Decisions without waiting for the graph", () => {
    // Waiting chained the tab's own requests behind the graph's (finding #26).
    renderLoading("delivery");
    expect(screen.getByText("delivery-view")).toBeInTheDocument();
    expect(screen.queryByText("Loading project…")).not.toBeInTheDocument();
    cleanup();
    renderLoading("decisions");
    expect(screen.getByText("decisions-view")).toBeInTheDocument();
    expect(screen.queryByText("Loading project…")).not.toBeInTheDocument();
  });

  it("holds the breadcrumb's place with a skeleton until the name arrives", () => {
    renderLoading("tasks");
    expect(screen.getByRole("navigation", { name: "crumbs" })).toHaveTextContent(
      "WS / [skeleton]",
    );
    cleanup();
    graphLoaded = true;
    render(
      <ProjectPage
        params={Promise.resolve({ workspaceId: "w1", projectId: "p1" })}
      />,
    );
    expect(screen.getByRole("navigation", { name: "crumbs" })).toHaveTextContent("WS / P");
  });
});
